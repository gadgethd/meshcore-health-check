// Initialize the ESM-only renderer before the classic Leaflet bridge executes.
// Its adjacent module worker stays same-origin without blob: or unsafe-eval.

// MapLibre 6 removed supported(). Check WebGL2 before bridge construction:
// its synchronous GPU error precedes the bridge's error listener attachment.
function supported() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2');
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return Boolean(context);
}

try {
  const maplibregl = await import('/vendor/maplibre/maplibre-gl.mjs');
  window.maplibregl = { ...maplibregl, supported };
  await import('/vendor/maplibre-leaflet/leaflet-maplibre-gl.js');
} catch {
  // Optional vector assets must not block the dashboard or OSM fallback.
  window.maplibregl = null;
}
