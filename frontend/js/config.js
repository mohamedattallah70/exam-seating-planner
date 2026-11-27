// Frontend configuration: the ONLY file to edit to point the pages at a different API.
// Nothing here is secret: every visitor can read it. Never put DATABASE_URL or keys here.
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

// After deploying the API, replace YOUR-API-PROJECT with the Vercel API project domain.
const API_BASE_URL = isLocal
  ? 'http://localhost:3000'
  : 'https://seat-planner-api.vercel.app.';
