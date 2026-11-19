// Перезапуск AppImage. Нельзя просто вызвать app.relaunch(): новый процесс наследует окружение,
// которое AppRun настроил под ВРЕМЕННЫЙ mount старого процесса (LD_LIBRARY_PATH, PATH, ...),
// и системный fusermount не может смонтировать новый образ ("Cannot mount AppImage").
const { spawn } = require('child_process');
const os = require('os');

const PATH_LIKE = ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];
const DROP = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'];

function cleanEnv(env) {
  const appdir = env.APPDIR || '';
  const out = { ...env };
  for (const key of PATH_LIKE) {
    if (out[key] === undefined) continue;
    const kept = out[key].split(':').filter(
      (p) => p && p !== './share/' && !(appdir && (p === appdir || p.startsWith(appdir + '/')))
    );
    if (kept.length) out[key] = kept.join(':'); else delete out[key];
  }
  for (const key of DROP) delete out[key];
  for (const key of Object.keys(out)) if (key.startsWith('APPIMAGE_')) delete out[key];
  return out;
}

// Ждёт выхода текущего процесса (освобождение single-instance lock и mount), затем запускает AppImage заново
function relaunchAppImage(appImagePath, args, parentPid, env = process.env) {
  const script =
    'n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n+1)); done; ' +
    'sleep 0.5; shift; exec "$0" "$@"';
  const child = spawn('/bin/sh', ['-c', script, appImagePath, String(parentPid), ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: os.homedir(),
    env: cleanEnv(env),
  });
  child.unref();
}

module.exports = { cleanEnv, relaunchAppImage };
