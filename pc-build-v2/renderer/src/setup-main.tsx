import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { SetupApp } from './setup/SetupApp'
import './styles/global.css'
import './styles/setup.css'

const root = document.querySelector('#root')
if (root === null) throw new Error('Setup root element is missing')

createRoot(root).render(
  <StrictMode>
    <SetupApp />
  </StrictMode>,
)
