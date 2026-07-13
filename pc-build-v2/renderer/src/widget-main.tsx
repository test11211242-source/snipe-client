import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { WidgetApp } from './widget/WidgetApp'
import './styles/widget.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Widget root element is missing')

createRoot(root).render(
  <StrictMode>
    <WidgetApp />
  </StrictMode>,
)
