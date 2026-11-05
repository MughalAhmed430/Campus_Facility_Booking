import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';
import apiRoutes from './routes/index.js';
import notFound from './middleware/not-found.js';
import errorHandler from './middleware/error-handler.js';
import verifyOrigin from './middleware/verify-origin.js';

const clientDir = path.resolve(import.meta.dirname, '../../client');

const app = express();

// Security headers, including a Content-Security-Policy that only allows scripts
// and styles from this server: no inline <script> blocks or onclick="" attributes.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // Over plain http (localhost, or a phone on the LAN testing the responsive
        // layout) this directive would make the browser request assets over https and fail.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
  }),
);

// Pages served by this server call the API same-origin and need no CORS. A frontend on
// another origin (e.g. VS Code Live Server on :5500) must be listed in CORS_ORIGINS.
// credentials: true lets that origin send and receive the session cookie; the
// browser requires an exact origin for this (a "*" wildcard is not allowed).
app.use(
  '/api',
  cors({
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    credentials: true,
  }),
);
app.use('/api', verifyOrigin);
app.use('/api', cookieParser());
app.use('/api', express.json({ limit: '100kb' }));
app.use('/api', apiRoutes);

app.use(express.static(clientDir));

app.use(notFound);
app.use(errorHandler);

export default app;
