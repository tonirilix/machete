import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
      <Toaster
        theme="light"
        position="bottom-center"
        offset={72}
        visibleToasts={1}
        duration={2200}
        richColors
        closeButton
      />
    </TooltipProvider>
  </StrictMode>,
)
