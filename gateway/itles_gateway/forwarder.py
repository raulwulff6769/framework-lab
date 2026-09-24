"""Moves queued records to the platform API; idempotent because the API dedupes by (source, time)."""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request

from .queue import DurableQueue

log = logging.getLogger("itles.forwarder")

# rejections that will never succeed on retry
PERMANENT = {
    "bad_time", "time_too_old", "time_in_future", "bad_coordinates", "bad_engine_hours", "bad_odometer",
    "no_data", "not_an_object", "bad_sensor", "machine_deleted",
}


class Forwarder:
    def __init__(self, queue: DurableQueue, api_url: str, token: str, batch: int = 1000, timeout: float = 30.0):
        self.q = queue
        self.url = api_url.rstrip("/") + "/api/ingest"
        self.token = token
        self.batch = batch
        self.timeout = timeout
        self.stop = threading.Event()
        # monitoring only (status file of the live stand)
        self.forwarded = 0
        self.last_ok_t: float | None = None
        self.last_error: str | None = None

    def post(self, records: list[dict]) -> dict:
        body = json.dumps({"records": records}, separators=(",", ":")).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}", "x-itles-client": "gateway"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def run_once(self) -> int:
        items = self.q.take(self.batch)
        if not items:
            return 0
        records = [{**payload, "ext_id": ext} for (_i, ext, payload, _t) in items]
        ids = [i for (i, *_rest) in items]
        try:
            res = self.post(records)
        except urllib.error.HTTPError as e:
            log.warning("platform HTTP %s; keeping %d records", e.code, len(ids))
            self.last_error = f"HTTP {e.code}"
            self.q.retry(ids, f"http {e.code}")
            return 0
        except Exception as e:  # network, timeout, bad JSON: keep everything
            log.warning("platform unreachable (%s); keeping %d records", e, len(ids))
            self.last_error = str(e)[:200]
            self.q.retry(ids, str(e))
            return 0

        by_ext: dict[str, list[int]] = {}
        for i, record in enumerate(records):
            by_ext.setdefault(record["ext_id"], []).append(i)
        done: list[int] = []
        parked: list[int] = []
        retry: list[int] = []
        try:
            if not isinstance(res, dict) or not isinstance(res.get("results"), list):
                raise ValueError("missing results")
            seen: set[str] = set()
            for r in res["results"]:
                if not isinstance(r, dict) or not isinstance(r.get("ext_id"), str):
                    raise ValueError("invalid result")
                ext = r["ext_id"]
                if ext not in by_ext or ext in seen:
                    raise ValueError("unexpected or duplicate device")
                seen.add(ext)
                indexes = by_ext[ext]
                if r.get("status") == "unknown_device":
                    reported = r.get("indexes")
                    if (not isinstance(reported, list) or len(reported) != len(indexes)
                            or any(type(i) is not int for i in reported) or set(reported) != set(indexes)):
                        raise ValueError("invalid unknown device indexes")
                    parked.extend(ids[i] for i in indexes)
                elif r.get("status") == "ok":
                    rejected = r.get("rejected")
                    if not isinstance(rejected, list):
                        raise ValueError("missing rejections")
                    bad: dict[int, str] = {}
                    for x in rejected:
                        if (not isinstance(x, dict) or type(x.get("index")) is not int
                                or x["index"] not in indexes or x["index"] in bad
                                or not isinstance(x.get("reason"), str) or not x["reason"]):
                            raise ValueError("invalid rejection")
                        bad[x["index"]] = x["reason"]
                    for i in indexes:
                        reason = bad.get(i)
                        if reason is None or reason in PERMANENT:
                            done.append(ids[i])
                        else:
                            retry.append(ids[i])
                else:
                    retry.extend(ids[i] for i in indexes)
            for ext, indexes in by_ext.items():
                if ext not in seen:
                    retry.extend(ids[i] for i in indexes)
        except ValueError:
            log.warning("invalid platform acknowledgement; keeping %d records", len(ids))
            self.q.retry(ids, "invalid_response")
            return 0

        self.q.ack(done)
        self.forwarded += len(done)
        self.last_ok_t = time.time()
        self.last_error = None
        if parked:
            self.q.retry(parked, "unknown_device", park=True)
        if retry:
            self.q.retry(retry, "unconfirmed_response")
        return len(done)

    def loop(self, idle: float = 1.0) -> None:
        while not self.stop.is_set():
            try:
                n = self.run_once()
            except Exception:
                log.exception("forwarder iteration failed")
                n = 0
            if n == 0:
                self.stop.wait(idle)
