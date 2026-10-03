import '@xterm/xterm/css/xterm.css'
import './style.css'
import { showSplashScreen } from './views/splashScreen'
import { renderSessionList } from './views/dashboard'

if (!document.getElementById('app')) {
  throw new Error('Missing #app element')
}

void showSplashScreen().then(() => renderSessionList())
