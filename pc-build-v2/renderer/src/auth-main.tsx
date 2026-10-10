import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AuthApp } from './auth/AuthApp'
import './styles/global.css'
import './styles/auth.css'

const root = document.getElementById('root')
document.documentElement.classList.add('legacy-host')
if (root === null) throw new Error('Auth renderer root element is missing')

createRoot(root).render(
  <StrictMode>
    <AuthApp />
  </StrictMode>,
)
