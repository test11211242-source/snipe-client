import { randomBytes } from 'node:crypto'

import type { Plugin } from 'vite'

export function developmentCsp(): Plugin {
  const nonce = randomBytes(18).toString('base64')

  return {
    name: 'cr-tools-development-csp',
    apply: 'serve',
    config: () => ({ html: { cspNonce: nonce } }),
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const websocketOrigins = (context.server?.resolvedUrls?.local ?? []).map(
          (address) => {
            const url = new URL(address)
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
            return url.origin
          },
        )

        return html.replace(
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/g,
          (_match: string, start: string, policy: string, end: string) => {
            const directives = policy.split(';').map((directive) => {
              const [name, ...sources] = directive.trim().split(/\s+/)
              if (name === 'script-src' || name === 'style-src') {
                return [name, ...sources, `'nonce-${nonce}'`].join(' ')
              }
              if (name === 'connect-src') {
                return [
                  name,
                  ...new Set([
                    ...sources.filter((source) => source !== "'none'"),
                    "'self'",
                    ...websocketOrigins,
                  ]),
                ].join(' ')
              }
              return directive.trim()
            })

            return `${start}${directives.join('; ')}${end}`
          },
        )
      },
    },
  }
}
