// The canonical streamlink_status mock for App-mount suites: the REAL
// command's shape (resolve.rs StreamlinkStatus) — present, platform, and a
// parseable version ABOVE the support floor, so App's version-floor hint
// path runs the way it does on a healthy install. The old test mocks
// returned { present, targetOs } — a shape the command never produces.
export const STREAMLINK_STATUS_OK = { present: true, platform: 'linux', version: '7.0.0' } as const
