"""Local prediction API fixture: real server/PostgreSQL, synthetic auth and fake Helix.

Run with the Windows server venv and --server-worktree. Only an isolated schema in
compose.yaml's loopback development PostgreSQL is used; shutdown removes it.
"""
import argparse
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server-worktree', required=True, type=Path)
parser.add_argument('--port', type=int, default=18764)
args = parser.parse_args()
root = args.server_worktree.resolve()
os.environ['SNIPE_LOCAL_PROFILE'] = '1'
os.environ['SNIPE_CONFIG_PATH'] = str(root / 'config/config.ini.example')
os.environ['JWT_SECRET_KEY'] = uuid4().hex + uuid4().hex
sys.path[:0] = [str(root / 'server'), str(root / 'server/tests')]

import asyncpg
from aiohttp import ClientSession
from fastapi import FastAPI
import uvicorn
from fakes.fake_helix import FakeHelix
from routers import streamer_predictions
from routers.streamer import get_streamer_user
from services.streamer_predictions.repository import StreamerPredictionsRepository
from services.streamer_predictions.service import StreamerPredictionsService
from services.streamer_predictions.scheduler import PredictionScheduler
from services.twitch_predictions import TwitchPredictionsClient

USER = 'synthetic-predictions-client'
SCHEMA = 'predictions_client_' + uuid4().hex
LOCAL_DATABASE = dict(host='127.0.0.1', port=15432, user='snipe_dev',
                      password='snipe_dev_local', database='snipe_dev')


@asynccontextmanager
async def lifespan(app):
    admin = await asyncpg.connect(**LOCAL_DATABASE)
    pool = None
    try:
        await admin.execute(f'CREATE SCHEMA {SCHEMA}')
        await admin.execute(f'SET search_path TO {SCHEMA}')
        for name in (
            '077_add_streamer_predictions.sql',
            '078_add_prediction_live_override.sql',
            '079_harden_streamer_predictions.sql',
            '080_allow_imported_prediction_windows.sql',
            '081_verify_prediction_outcome_mapping.sql',
            '082_close_external_predictions.sql',
        ):
            await admin.execute((root / 'data/migrations' / name).read_text(encoding='utf-8'))
        pool = await asyncpg.create_pool(**LOCAL_DATABASE,
            server_settings={'search_path': SCHEMA}, min_size=1, max_size=4)

        @asynccontextmanager
        async def connection():
            async with pool.acquire() as conn:
                yield conn

        repository = StreamerPredictionsRepository(SimpleNamespace(_get_connection=connection))
        async with FakeHelix() as helix:
            os.environ['SNIPE_TWITCH_HELIX_BASE_URL'] = helix.base_url

            async def token_provider(*, force_refresh=False):
                return {'access_token': 'db-token', 'broadcaster_id': 'synthetic-channel'}

            async def live_status(_user_id):
                return {'online': True}

            service = StreamerPredictionsService(repository,
                lambda _: TwitchPredictionsClient(token_provider, 'synthetic-client'),
                live_status, clock=lambda: datetime.now(timezone.utc))
            app.state.streamer_predictions = service
            app.state.smoke = SimpleNamespace(pool=pool, helix=helix)
            scheduler = PredictionScheduler(service)
            await scheduler.start()
            try:
                yield
            finally:
                await scheduler.stop()
                await service.close()
    finally:
        if pool is not None:
            await pool.close()
        await admin.execute(f'DROP SCHEMA IF EXISTS {SCHEMA} CASCADE')
        await admin.close()


app = FastAPI(lifespan=lifespan)
app.include_router(streamer_predictions.router)


async def user():
    return {'user': {'id': USER}}


app.dependency_overrides[get_streamer_user] = user


@app.get('/health')
async def health():
    async with app.state.smoke.pool.acquire() as conn:
        await conn.fetchval('SELECT 1')
    return {'status': 'healthy', 'fixture': 'real-postgres-fake-helix'}


@app.get('/api/streamer/auth/status')
async def twitch_status():
    return {'success': True, 'connected': True, 'username': 'synthetic_streamer'}


@app.get('/api/streamer/title/status')
@app.get('/api/streamer/settings/deck-sharing')
@app.get('/api/streamer/opponent-widget/status')
async def unrelated_status():
    return {'success': True, 'settings': {}, 'accounts': []}


@app.post('/__smoke/tick')
async def tick():
    await app.state.streamer_predictions.tick(USER)
    return await app.state.streamer_predictions.status(USER)


@app.post('/__smoke/foreign')
async def foreign_prediction():
    async with ClientSession() as http:
        async with http.post(
            f'{app.state.smoke.helix.base_url}/predictions',
            headers={'Authorization': 'Bearer db-token', 'Client-Id': 'synthetic-client'},
            json={
                'broadcaster_id': 'synthetic-channel',
                'title': 'Прогноз с Twitch',
                'prediction_window': 61,
                'outcomes': [{'title': 'Первый'}, {'title': 'Второй'}],
            },
        ) as response:
            if response.status != 200:
                raise RuntimeError('Synthetic foreign prediction creation failed')
    return {'created': True}


@app.post('/__smoke/foreign/resolve')
async def resolve_foreign_on_twitch():
    """The streamer resolves the open foreign prediction on Twitch (first outcome wins)."""
    [open_prediction] = [item for item in app.state.smoke.helix.predictions.values()
                         if item['status'] in ('ACTIVE', 'LOCKED')]
    async with ClientSession() as http:
        async with http.patch(
            f'{app.state.smoke.helix.base_url}/predictions',
            headers={'Authorization': 'Bearer db-token', 'Client-Id': 'synthetic-client'},
            json={
                'broadcaster_id': 'synthetic-channel',
                'id': open_prediction['id'],
                'status': 'RESOLVED',
                'winning_outcome_id': open_prediction['outcomes'][0]['id'],
            },
        ) as response:
            if response.status != 200:
                raise RuntimeError('Synthetic foreign prediction resolution failed')
    return {'resolved': True}


@app.post('/__smoke/bets')
async def bets():
    for item in app.state.smoke.helix.predictions.values():
        if item['status'] in ('ACTIVE', 'LOCKED'):
            item['outcomes'][0]['users'] = 1
            item['outcomes'][0]['channel_points'] = 100
    return {'bets': True}


@app.get('/__smoke/evidence')
async def evidence():
    async with app.state.smoke.pool.acquire() as conn:
        battles = await conn.fetch('SELECT battle_id,kind,evidence,outcome,outcome_source FROM streamer_prediction_battles ORDER BY id')
    return {
        'heartbeatsReady': (await app.state.streamer_predictions.status(USER))['clientReady'],
        'battles': [dict(row) for row in battles],
        'helixRequests': len(app.state.smoke.helix.requests),
        'chatMessages': len(app.state.smoke.helix.chat_messages),
    }


@app.post('/__smoke/reset')
async def reset():
    async with app.state.streamer_predictions.repository.transaction(USER) as tx:
        await tx.conn.execute('TRUNCATE streamer_prediction_operations, streamer_prediction_manual_requests, streamer_prediction_battles, streamer_predictions, streamer_prediction_settings RESTART IDENTITY')
        app.state.smoke.helix.predictions.clear()
        app.state.smoke.helix.requests.clear()
        app.state.smoke.helix.chat_messages.clear()
        app.state.smoke.helix._next_id = 1
    return {'reset': True}


@app.post('/__smoke/shutdown')
async def shutdown():
    app.state.server.should_exit = True
    return {'stopping': True}


if __name__ == '__main__':
    app.state.server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1',
        port=args.port, log_level='warning', access_log=False))
    app.state.server.run()
