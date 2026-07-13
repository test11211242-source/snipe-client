import type { Session } from 'electron'

export function installDenyAllSessionPermissions(session: Session): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  )
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
}
