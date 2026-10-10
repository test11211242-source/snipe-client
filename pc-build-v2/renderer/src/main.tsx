import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AppRoot } from './app/AppRoot'
import './styles/tokens.css'
import './styles/base.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Renderer root element is missing')

createRoot(root).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
)
