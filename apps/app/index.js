import { registerRootComponent } from 'expo';
import { loadLanguage } from './src/i18n/load';

// The chosen language's text is fetched first (t() is read while the screens load), then the app starts.
loadLanguage().then(() => registerRootComponent(require('./src/App').default));
