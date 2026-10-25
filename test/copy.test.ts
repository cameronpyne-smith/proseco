import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { replaceTree } from "../src/fixer/sandbox/copy.ts";
import { readTar, type TarEntry } from "../src/fixer/sandbox/tar.ts";

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `proseco-${prefix}-`));
}

function archive(directory: string, format: "gnu" | "pax"): Buffer {
  return execFileSync("tar", ["-C", directory, `--format=${format}`, "-cf", "-", "."], { maxBuffer: 64 * 1024 * 1024 });
}

function header(name: string, type: string, size = 0, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write(type, 156);
  block.write(link, 157, 100);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.fill(32, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function crafted(...entries: { name: string; type?: string; data?: string; link?: string }[]): Buffer {
  const parts = entries.flatMap((entry) => {
    const data = Buffer.from(entry.data ?? "");
    return [header(entry.name, entry.type ?? "0", data.length, entry.link), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
  });
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function checkout(): string {
  const root = temp("copy-target");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "stale.txt"), "old");
  return root;
}

describe("readTar and replaceTree", () => {
  for (const format of ["gnu", "pax"] as const) {
    it(`rebuilds the tree from a ${format} archive and keeps the host's .git`, () => {
      const source = temp("copy-source");
      const long = `${"deep/".repeat(30)}file-ñame.txt`;
      mkdirSync(join(source, "deep/".repeat(30)), { recursive: true });
      writeFileSync(join(source, long), "long");
      writeFileSync(join(source, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(source, "run.sh"), 0o755);
      writeFileSync(join(source, "binary.bin"), Buffer.from([0, 1, 255]));
      mkdirSync(join(source, "empty"));
      symlinkSync("run.sh", join(source, "alias"));
      const root = checkout();
      replaceTree(root, readTar(archive(source, format)));
      assert.equal(readFileSync(join(root, long), "utf8"), "long");
      assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
      assert.equal(statSync(join(root, long)).mode & 0o777, 0o644);
      assert.deepEqual(readFileSync(join(root, "binary.bin")), Buffer.from([0, 1, 255]));
      assert.ok(statSync(join(root, "empty")).isDirectory());
      assert.equal(readlinkSync(join(root, "alias")), "run.sh");
      assert.equal(existsSync(join(root, "stale.txt")), false);
      assert.equal(readFileSync(join(root, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    });
  }

  it("skips .git, node_modules and .venv from the archive", () => {
    const root = checkout();
    replaceTree(
      root,
      readTar(crafted({ name: "./.git/config", data: "[core]\n\tfsmonitor = x\n" }, { name: "./node_modules/x/index.js", data: "x" }, { name: "./svc/.venv/bin/python", data: "x" }, { name: "./a.txt", data: "a" })),
    );
    assert.equal(existsSync(join(root, ".git", "config")), false);
    assert.equal(existsSync(join(root, "node_modules")), false);
    assert.equal(existsSync(join(root, "svc", ".venv")), false);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a");
  });

  const refused: [string, TarEntry[] | Buffer, RegExp][] = [
    ["a path with ..", crafted({ name: "./a/../../x", data: "x" }), /leaves the repository/],
    ["an absolute path", crafted({ name: "/tmp/x", data: "x" }), /leaves the repository/],
    ["an absolute symlink", crafted({ name: "./link", type: "2", link: "/home" }), /outside the repository/],
    ["a symlink that climbs out", crafted({ name: "./a/link", type: "2", link: "../../x" }), /outside the repository/],
    ["a symlink into .git", crafted({ name: "./link", type: "2", link: ".git/config" }), /outside the repository/],
    ["a hard link", crafted({ name: "./x", type: "1", link: "y" }), /hard link/],
    ["a device", crafted({ name: "./x", type: "3" }), /tar entry of type "3"/],
    ["a file under a symlinked directory", crafted({ name: "./a", type: "2", link: "b" }, { name: "./a/x", data: "x" }), /EEXIST|not a directory/],
    ["the same file twice", crafted({ name: "./x", data: "1" }, { name: "./x", data: "2" }), /EEXIST/],
  ];
  for (const [what, tar, message] of refused) {
    it(`refuses ${what} and writes nothing outside`, () => {
      const parent = temp("copy-parent");
      const root = join(parent, "work");
      mkdirSync(join(root, ".git"), { recursive: true });
      assert.throws(() => replaceTree(root, Buffer.isBuffer(tar) ? readTar(tar) : tar), message);
      assert.deepEqual(execFileSync("find", [parent, "-not", "-path", `${root}*`], { encoding: "utf8" }).trim(), parent);
    });
  }

  it("refuses a header with a bad checksum", () => {
    const tar = crafted({ name: "./x", data: "x" });
    tar[0] = 0x41;
    assert.throws(() => readTar(tar), /bad checksum/);
  });

  it("refuses an entry that runs past the end of the archive", () => {
    assert.throws(() => readTar(Buffer.concat([header("./x", "0", 4096), Buffer.alloc(512)])), /runs past the end/);
  });
});
