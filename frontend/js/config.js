// Public configuration only (no secrets ever go in frontend code).
window.ESP_CONFIG = {
  // The API gateway. The frontend itself is served from S3 on Floci.
  API_BASE: 'http://localhost:8080/api',
};
