import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react-swc'
import { createServer, resolveConfig, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { developmentCsp } from './development-csp'

const root = resolve(import.meta.dirname, 'renderer')

describe('renderer development CSP', () => {
  let server: ViteDevServer

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root,
      plugins: [developmentCsp(), react()],
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'silent',
    })
    server.resolvedUrls = { local: ['http://localhost:5173/'], network: [] }
  })

  afterAll(async () => {
    await server.close()
  })

  it.each(['index', 'auth', 'setup', 'widget'])(
    'allows Vite styles, React refresh and its websocket in %s',
    async (page) => {
      const html = await readFile(resolve(root, `${page}.html`), 'utf8')
      const transformed = await server.transformIndexHtml(`/${page}.html`, html)
      const nonce = server.config.html?.cspNonce
      expect(nonce).toBeTruthy()
      expect(transformed).toContain(`property="csp-nonce" nonce="${nonce}"`)
      expect(transformed).toContain(`style-src 'self' 'nonce-${nonce}'`)
      expect(transformed).toContain(`script-src 'self' 'nonce-${nonce}'`)
      expect(transformed).toContain('window.$RefreshReg$')
      const scripts = transformed.match(/<script\b[^>]*>/g) ?? []
      expect(scripts.length).toBeGreaterThan(1)
      for (const script of scripts) {
        expect(script).toContain(`nonce="${nonce}"`)
      }
      const address = server.resolvedUrls?.local[0]
      expect(address).toBeTruthy()
      const websocket = new URL(address ?? '')
      websocket.protocol = 'ws:'
      expect(transformed).toContain(`connect-src 'self' ${websocket.origin}`)
      expect(transformed).not.toContain("'unsafe-inline'")
      expect(transformed).toContain("object-src 'none'")
    },
  )

  it('keeps development nonces and permissions out of production builds', async () => {
    const config = await resolveConfig(
      { configFile: false, root, plugins: [developmentCsp(), react()] },
      'build',
    )
    expect(
      config.plugins.some((plugin) => plugin.name === 'cr-tools-development-csp'),
    ).toBe(false)
    expect(config.html?.cspNonce).toBeUndefined()
    const widget = await readFile(resolve(root, 'widget.html'), 'utf8')
    expect(widget).toContain("style-src 'self';")
    expect(widget).toContain("script-src 'self';")
    expect(widget).toContain("connect-src 'none';")
  })
})
