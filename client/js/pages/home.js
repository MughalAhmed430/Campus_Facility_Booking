import { homeFor, initAppShell } from '../components/app-shell.js';

// The home page is the landing page for signed-out visitors. Signed-in users go
// straight to their start page.
const user = await initAppShell({ access: 'public' });
if (user) window.location.replace(homeFor(user));
