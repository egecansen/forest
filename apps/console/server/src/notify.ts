import { execFile } from 'node:child_process';

type ExecImpl = (cmd: string, args: string[]) => void;
const defaultExec: ExecImpl = (cmd, args) => { execFile(cmd, args, () => {}); };

export function makeNotifier(platform: NodeJS.Platform = process.platform, exec: ExecImpl = defaultExec) {
  const fire = (title: string, message: string) => {
    if (platform !== 'darwin' || process.env.NODE_ENV === 'test') return;
    // AppleScript string literal: strip backslashes/quotes rather than escape —
    // notification copy never needs them and this closes the injection seam.
    const clean = (s: string) => s.replace(/[\\"]/g, "'");
    exec('osascript', ['-e', `display notification "${clean(message)}" with title "${clean(title)}"`]);
  };
  return {
    decision: (message: string) => fire('hektor — decision needed', message),
    terminal: (title: string, message: string) => fire(title, message),
  };
}

const notifier = makeNotifier();
export const notifyDecision = notifier.decision;
export const notifyTerminal = notifier.terminal;
