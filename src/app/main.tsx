import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/space-grotesk/wght.css'
import { App } from './App'
import '../styles/app.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
