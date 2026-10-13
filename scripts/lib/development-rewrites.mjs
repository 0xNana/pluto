export function developmentApiRewrites(phase, environment = process.env) {
  if (phase !== 'phase-development-server' || !environment.PLUTO_DEV_API_ORIGIN) return { beforeFiles: [] };
  const origin = new URL(environment.PLUTO_DEV_API_ORIGIN);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Development API must be loopback');
  return { beforeFiles: ['/api/runtime', '/api/plan'].map(source => ({ source, destination: origin.origin + source })) };
}
