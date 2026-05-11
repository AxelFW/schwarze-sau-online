#!/usr/bin/env node
/*
  Patch: keep Easy Mode/Bot-Tipps accessible via URL while hiding the lobby option via env.

  Behavior after patch:
    - VITE_ENABLE_EASY_MODE=false hides the lobby checkbox only.
    - Easy mode is still accepted by client/server settings.
    - Open the app with ?easyMode=true, ?easy=true, or ?botTips=true to create rooms/solo games with Bot-Tipps enabled.
    - ?easyMode=false, ?easy=false, or ?botTips=false explicitly starts with it off.

  Usage:
    node patch-easy-mode-hidden-url.cjs .
    node patch-easy-mode-hidden-url.cjs /path/to/schwarze-sau-online
*/

const fs = require('fs');
const path = require('path');

const rootArg = process.argv[2] || '.';
const root = path.resolve(rootArg);

function pick(...parts) {
  return path.join(root, ...parts);
}

function findRepoRoot(start) {
  const candidates = [
    start,
    path.join(start, 'schwarze-sau-online'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'src'))) return c;
  }
  return start;
}

const repo = findRepoRoot(root);

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${path.relative(process.cwd(), file)}`);
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.writeFileSync(file, text);
}

function backup(file, tag) {
  const bak = `${file}.bak-${tag}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) throw new Error(`Could not find text block: ${label}`);
  return text.replace(search, replacement);
}

function replaceRegexOnce(text, regex, replacement, label) {
  if (!regex.test(text)) throw new Error(`Could not find regex block: ${label}`);
  return text.replace(regex, replacement);
}

const tag = 'easy-mode-hidden-url';

try {
  const appFile = path.join(repo, 'src', 'screens', 'OnlineLobby.jsx');
  const roomsFile = path.join(repo, 'server', 'rooms.js');
  const envExampleFile = path.join(repo, '.env.example');
  const renderFile = path.join(repo, 'render.yaml');

  // --- Client: hide option by env, but initialize preferredEasyMode from URL and do not clamp outgoing settings. ---
  let app = read(appFile);
  backup(appFile, tag);

  app = replaceOnce(app,
`const EASY_MODE_FEATURE_ENABLED =
  envFlagEnabled(import.meta.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(import.meta.env.VITE_EASY_MODE_ENABLED);
`,
`// This flag controls only whether the Easy Mode checkbox is shown in the lobby.
// Easy Mode itself can still be requested by URL, e.g. ?easyMode=true.
const EASY_MODE_OPTION_VISIBLE =
  envFlagEnabled(import.meta.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(import.meta.env.VITE_EASY_MODE_ENABLED);

const urlFlagValue = (...names) => {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search || "");
  for (const name of names) {
    if (!params.has(name)) continue;
    const raw = String(params.get(name) ?? "").trim().toLowerCase();
    if (["1", "true", "yes", "ja", "on"].includes(raw)) return true;
    if (["0", "false", "no", "nein", "off"].includes(raw)) return false;
  }
  return null;
};

const INITIAL_EASY_MODE_FROM_URL = urlFlagValue("easyMode", "easy", "botTips");
`, 'client easy-mode env block');

  app = replaceOnce(app,
`  const [preferredEasyMode, setPreferredEasyMode] = useState(false);
  const [easyModeFeatureEnabled, setEasyModeFeatureEnabled] = useState(EASY_MODE_FEATURE_ENABLED);
`,
`  const [preferredEasyMode, setPreferredEasyMode] = useState(INITIAL_EASY_MODE_FROM_URL === true);
  const [easyModeOptionVisible, setEasyModeOptionVisible] = useState(EASY_MODE_OPTION_VISIBLE);
`, 'client easy-mode state');

  app = replaceOnce(app,
`      if (msg.features?.easyMode !== undefined) {
        const enabled = Boolean(msg.features.easyMode);
        setEasyModeFeatureEnabled(enabled);
        if (!enabled) setPreferredEasyMode(false);
      }
`,
`      if (msg.features?.easyMode !== undefined) {
        // Server uses this flag only to tell the client whether the checkbox should be visible.
        // Do not reset preferredEasyMode here: URL-enabled hidden Easy Mode must stay possible.
        setEasyModeOptionVisible(Boolean(msg.features.easyMode));
      }
`, 'client serverHello easy-mode handling');

  app = replaceOnce(app,
`    const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: easyModeFeatureEnabled && preferredEasyMode } });
`,
`    const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });
`, 'client createRoom easy-mode clamp');

  app = replaceOnce(app,
`      easyMode: easyModeFeatureEnabled ? (nextSettings.easyMode ?? preferredEasyMode) : false,
`,
`      easyMode: nextSettings.easyMode ?? preferredEasyMode,
`, 'client updateRoomSettings easy-mode clamp');

  app = replaceOnce(app,
`    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: easyModeFeatureEnabled && preferredEasyMode } });
`,
`    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });
`, 'client startSoloGame easy-mode clamp');

  // There may be a second createRoom instance in some builds; replace all remaining old clamps.
  app = app.replaceAll('easyMode: easyModeFeatureEnabled && preferredEasyMode', 'easyMode: preferredEasyMode');
  app = app.replaceAll('easyMode: easyModeOptionVisible && preferredEasyMode', 'easyMode: preferredEasyMode');
  app = app.replaceAll('easyModeFeatureEnabled', 'easyModeOptionVisible');
  app = app.replaceAll('setEasyModeFeatureEnabled', 'setEasyModeOptionVisible');
  app = app.replaceAll('EASY_MODE_FEATURE_ENABLED', 'EASY_MODE_OPTION_VISIBLE');

  app = app.replaceAll('{easyModeOptionVisible && (', '{easyModeOptionVisible && (');

  write(appFile, app);

  // --- Server: env controls advertised checkbox visibility only; do not clamp easyMode off. ---
  let rooms = read(roomsFile);
  backup(roomsFile, tag);

  rooms = replaceOnce(rooms,
`export const EASY_MODE_FEATURE_ENABLED =
  envFlagEnabled(process.env.ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_EASY_MODE_ENABLED);
`,
`// This flag controls only whether the Easy Mode checkbox is advertised/shown.
// Easy Mode itself remains available for hidden URL-based access.
export const EASY_MODE_FEATURE_ENABLED =
  envFlagEnabled(process.env.ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_EASY_MODE_ENABLED);
`, 'server easy-mode flag comment');

  rooms = replaceOnce(rooms,
`    easyMode: EASY_MODE_FEATURE_ENABLED && settings.easyMode === true,
`,
`    easyMode: settings.easyMode === true,
`, 'server defaultRoomSettings easy-mode clamp');

  rooms = replaceOnce(rooms,
`  if (easyMode !== undefined) next.easyMode = EASY_MODE_FEATURE_ENABLED && easyMode === true;
`,
`  if (easyMode !== undefined) next.easyMode = easyMode === true;
`, 'server setRoomSettings easy-mode clamp');

  write(roomsFile, rooms);

  // --- Documentation/config comments. ---
  if (fs.existsSync(envExampleFile)) {
    let env = read(envExampleFile);
    backup(envExampleFile, tag);
    env = env.replace(
`# Easy-mode Bot-Tipps. Set VITE_ENABLE_EASY_MODE=false to hide the option in the lobby and force it off.
# ENABLE_EASY_MODE=false is an optional server-side alias; either false value disables the feature.
`,
`# Easy-mode Bot-Tipps. Set VITE_ENABLE_EASY_MODE=false to hide the option in the lobby.
# Hidden URL access stays possible with ?easyMode=true, ?easy=true, or ?botTips=true.
# ENABLE_EASY_MODE=false is an optional server-side alias for hiding the option.
`
    );
    write(envExampleFile, env);
  }

  if (fs.existsSync(renderFile)) {
    let render = read(renderFile);
    backup(renderFile, tag);
    render = render.replace(
`          value: "true"
`,
`          value: "true"
`
    );
    if (!render.includes('VITE_ENABLE_EASY_MODE=false hides only the lobby option')) {
      render = render.replace(
`      - key: VITE_ENABLE_EASY_MODE
`,
`      # VITE_ENABLE_EASY_MODE=false hides only the lobby option; ?easyMode=true can still enable Bot-Tipps.
      - key: VITE_ENABLE_EASY_MODE
`
      );
    }
    write(renderFile, render);
  }

  // Basic validation.
  const patchedApp = read(appFile);
  const patchedRooms = read(roomsFile);
  if (patchedApp.includes('easyModeFeatureEnabled')) throw new Error('Internal validation failed: old easyModeFeatureEnabled name still present.');
  if (patchedApp.includes('EASY_MODE_FEATURE_ENABLED')) throw new Error('Internal validation failed: old client EASY_MODE_FEATURE_ENABLED name still present.');
  if (patchedApp.includes('easyMode: easyModeOptionVisible && preferredEasyMode')) throw new Error('Internal validation failed: client still clamps easyMode to visibility.');
  if (patchedRooms.includes('easyMode: EASY_MODE_FEATURE_ENABLED && settings.easyMode === true')) throw new Error('Internal validation failed: server default settings still clamp easyMode.');
  if (patchedRooms.includes('next.easyMode = EASY_MODE_FEATURE_ENABLED && easyMode === true')) throw new Error('Internal validation failed: server settings update still clamps easyMode.');

  console.log('✅ Patched Easy Mode hidden URL access.');
  console.log(`   Repo: ${repo}`);
  console.log('   URL switches: ?easyMode=true, ?easy=true, ?botTips=true');
  console.log('   Backups:');
  console.log(`   - ${path.relative(repo, appFile)}.bak-${tag}`);
  console.log(`   - ${path.relative(repo, roomsFile)}.bak-${tag}`);
} catch (err) {
  console.error(`❌ Patch failed: ${err.message}`);
  process.exit(1);
}
