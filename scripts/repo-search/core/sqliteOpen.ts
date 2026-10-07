import { FFIType, dlopen } from "bun:ffi";
import { Database, constants as sqliteConstants } from "bun:sqlite";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";

export type FilesystemIdentity = {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
};

type OpenAnchoredSqliteInput = {
  directory: FilesystemIdentity;
  file: FilesystemIdentity;
  fileName: string;
  beforeOpen?: () => void;
  initialize: (db: Database) => void;
  error: (message: string, cause?: unknown) => Error;
};

let systemLibrary: ReturnType<typeof dlopen<{
  fchdir: { args: [typeof FFIType.i32]; returns: typeof FFIType.i32 };
}>> | undefined;

function fchdir(fd: number): number {
  if (!systemLibrary) {
    const library =
      process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : process.platform === "linux"
          ? "libc.so.6"
          : null;
    if (library === null) {
      throw new Error(`Anchored SQLite opening is unsupported on ${process.platform}.`);
    }
    systemLibrary = dlopen(library, {
      fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
    });
  }
  return systemLibrary.symbols.fchdir(fd);
}

function sameIdentity(
  actual: { dev: number | bigint; ino: number | bigint },
  expected: FilesystemIdentity,
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

/**
 * Open and initialize SQLite while the process is synchronously anchored to an
 * already-open directory descriptor. SQLite resolves its main file and
 * journals from that directory even if the pathname is concurrently replaced.
 */
export function openAnchoredSqlite(input: OpenAnchoredSqliteInput): Database {
  if (
    input.fileName.length === 0 ||
    input.fileName === "." ||
    input.fileName === ".." ||
    input.fileName.includes("/")
  ) {
    throw input.error(`Invalid SQLite filename: ${input.fileName}`);
  }

  let directoryFd: number | undefined;
  let cwdFd: number | undefined;
  let switchedDirectory = false;
  let db: Database | undefined;

  try {
    directoryFd = openSync(
      input.directory.path,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    if (!sameIdentity(fstatSync(directoryFd), input.directory)) {
      throw input.error(`SQLite directory changed: ${input.directory.path}`);
    }
    cwdFd = openSync(".", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);

    input.beforeOpen?.();

    if (fchdir(directoryFd) !== 0) {
      throw input.error(`Could not enter SQLite directory: ${input.directory.path}`);
    }
    switchedDirectory = true;

    db = new Database(
      input.fileName,
      sqliteConstants.SQLITE_OPEN_READWRITE |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );

    const openedFile = lstatSync(input.fileName);
    if (
      openedFile.isSymbolicLink() ||
      !openedFile.isFile() ||
      !sameIdentity(openedFile, input.file)
    ) {
      throw input.error(`SQLite database changed before initialization: ${input.file.path}`);
    }

    const currentDirectory = lstatSync(input.directory.path);
    if (
      currentDirectory.isSymbolicLink() ||
      !currentDirectory.isDirectory() ||
      !sameIdentity(currentDirectory, input.directory)
    ) {
      throw input.error(`SQLite directory changed before initialization: ${input.directory.path}`);
    }

    input.initialize(db);
    return db;
  } catch (cause) {
    if (db) {
      try {
        db.close();
      } catch {
        // Preserve the opening error.
      }
    }
    if (cause instanceof Error) throw cause;
    throw input.error("SQLite database opening failed.", cause);
  } finally {
    let restorationError: Error | undefined;
    if (switchedDirectory && cwdFd !== undefined && fchdir(cwdFd) !== 0) {
      if (db) {
        try {
          db.close();
        } catch {
          // Restoration failure is the primary error.
        }
      }
      restorationError = input.error("Could not restore the process working directory.");
    }
    if (cwdFd !== undefined) closeSync(cwdFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    if (restorationError) throw restorationError;
  }
}
