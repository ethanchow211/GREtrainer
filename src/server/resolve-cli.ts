import { existsSync, statSync } from 'node:fs'
import { join, extname, delimiter } from 'node:path'

/**
 * Find the `claude` executable.
 *
 * Why this exists rather than just spawning "claude": on Windows, Node can only
 * resolve a bare command name by handing it to a shell, and a shell mangles
 * arguments -- it concatenates them without escaping, which silently drops
 * empty-string arguments like `--tools ""`. Since two of our most important flags
 * take an empty string, we must spawn the binary directly by absolute path with no
 * shell involved.
 */

export type ResolvedCli = {
  /** The program to spawn. */
  command: string
  /** Arguments to place before the real ones (used to run a .cmd shim via cmd.exe). */
  prefixArgs: string[]
  /** Where it was found, for error messages. */
  foundAt: string
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function searchPath(name: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)

  // A well-known install location that is not always on PATH for non-login shells.
  if (process.env.USERPROFILE) dirs.push(join(process.env.USERPROFILE, '.local', 'bin'))
  if (process.env.HOME) dirs.push(join(process.env.HOME, '.local', 'bin'))

  for (const dir of dirs) {
    if (extname(name) !== '') {
      const direct = join(dir, name)
      if (isFile(direct)) return direct
      continue
    }
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

let cached: ResolvedCli | null = null

export function resolveClaudeCli(): ResolvedCli {
  if (cached) return cached

  const found = searchPath('claude')
  if (!found) {
    throw new Error(
      'Could not find the `claude` command on this machine. Claude Code must be ' +
        'installed and signed in, because it is what authenticates against your ' +
        'subscription. Check that `claude --version` works in a terminal.',
    )
  }

  const ext = extname(found).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    // A batch shim cannot be executed directly; it must go through the command
    // processor. Passing an args array (with shell:false) keeps Node's proper
    // argument escaping, so empty-string arguments survive.
    cached = {
      command: process.env.ComSpec ?? 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', found],
      foundAt: found,
    }
  } else {
    cached = { command: found, prefixArgs: [], foundAt: found }
  }
  return cached
}
