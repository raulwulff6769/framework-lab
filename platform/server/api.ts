// Registers every API route on the shared router (route modules live in server/routes/).
import './routes/auth.js';
import './routes/admin.js';
import './routes/machines.js';
import './routes/devices.js';
import './routes/connectors.js';
import './routes/stand.js';

export { APP_VERSION, readCookie, router, type Ctx } from './core.js';
