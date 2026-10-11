import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { CatalogApp } from './catalog/CatalogApp'
import './styles/tokens.css'
import './styles/base.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Catalog root element is missing')

createRoot(root).render(
  <StrictMode>
    <CatalogApp />
  </StrictMode>,
)
