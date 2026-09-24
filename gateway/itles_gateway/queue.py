"""Durable FIFO in SQLite (WAL, synchronous=FULL).

A device deletes its archive after our ACK, so records are committed to disk before the ACK is
written to the socket. Records leave the queue only when the platform confirms them (stored or
duplicate) or rejects them as invalid; unknown trackers are parked and retried.
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import threading
import time

SCHEMA = """
create table if not exists q (
  id integer primary key autoincrement,
  ext_id text not null,
  proto text not null,
  received_at real not null,
  payload text not null,
  tries integer not null default 0,
  next_try real not null default 0,
  last_error text
);
create index if not exists q_next on q(next_try, id);
"""

PARK_MAX_S = 3600.0
RETENTION_S = 60 * 86400.0


def _private_file(path: str, create: bool = False) -> None:
    if not create and not os.path.lexists(path):
        return
    nofollow = os.O_NOFOLLOW
    try:
        if create:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | nofollow, 0o600)
        else:
            fd = os.open(path, os.O_RDONLY | nofollow)
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | nofollow)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("queue path must be a regular file")
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


class DurableQueue:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        if path != ":memory:":
            if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "fchmod"):
                raise OSError("file-backed gateway queue requires POSIX file permissions")
            parent = os.path.dirname(os.path.abspath(path))
            # SQLite reopens by name, so another user must not be able to replace the file.
            if os.stat(parent).st_mode & 0o022:
                raise OSError("gateway queue directory must not be writable by other users")
            # Crash leftovers may contain the same raw coordinates as the database.
            _private_file(path, create=True)
            _private_file(path + "-wal")
            _private_file(path + "-shm")
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma synchronous=full")
        self.db.executescript(SCHEMA)

    def put(self, ext_id: str, proto: str, records: list[dict]) -> None:
        if not records:
            return
        now = time.time()
        with self.lock:
            self.db.execute("begin immediate")
            try:
                self.db.executemany(
                    "insert into q (ext_id, proto, received_at, payload) values (?, ?, ?, ?)",
                    [(ext_id, proto, now, json.dumps(r, separators=(",", ":"))) for r in records],
                )
                self.db.execute("commit")
            except Exception:
                self.db.execute("rollback")
                raise

    def take(self, limit: int = 1000) -> list[tuple[int, str, dict, int]]:
        with self.lock:
            rows = self.db.execute(
                "select id, ext_id, payload, tries from q where next_try <= ? order by id limit ?", (time.time(), limit)
            ).fetchall()
        return [(i, e, json.loads(p), t) for i, e, p, t in rows]

    def ack(self, ids: list[int]) -> None:
        if not ids:
            return
        with self.lock:
            self.db.execute("begin immediate")
            self.db.executemany("delete from q where id = ?", [(i,) for i in ids])
            self.db.execute("commit")

    def retry(self, ids: list[int], error: str, park: bool = False) -> None:
        now = time.time()
        with self.lock:
            self.db.execute("begin immediate")
            for i in ids:
                row = self.db.execute("select tries, received_at from q where id = ?", (i,)).fetchone()
                if not row:
                    continue
                tries, received = row
                if park and now - received > RETENTION_S:
                    self.db.execute("delete from q where id = ?", (i,))
                    continue
                delay = min(PARK_MAX_S if park else 300.0, 5.0 * (2 ** min(tries, 10)))
                self.db.execute(
                    "update q set tries = tries + 1, next_try = ?, last_error = ? where id = ?", (now + delay, error[:300], i)
                )
            self.db.execute("commit")

    def size(self) -> int:
        with self.lock:
            return self.db.execute("select count(*) from q").fetchone()[0]

    def unpark(self, ext_ids: list[str]) -> int:
        """Retry parked records of devices that were just registered on the platform, without waiting."""
        if not ext_ids:
            return 0
        with self.lock:
            cur = self.db.execute(
                f"update q set next_try = 0 where last_error = 'unknown_device' and ext_id in ({','.join('?' * len(ext_ids))})", ext_ids
            )
            return cur.rowcount

    def by_device(self) -> dict[str, int]:
        with self.lock:
            return dict(self.db.execute("select ext_id, count(*) from q group by ext_id").fetchall())

    def close(self) -> None:
        self.db.close()
