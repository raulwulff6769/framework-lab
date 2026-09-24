import type { Db } from '../db.js';
import { decryptSecret } from '../secrets.js';
import { ingestForSource, type IngestResult } from '../ingest.js';
import { aempUnits } from './aemp.js';
import { traccarUnits } from './traccar.js';
import { ConnectorError, type RemoteUnit } from './types.js';
import { wialonUnits } from './wialon.js';
import { randomUUID } from 'node:crypto';

export interface SyncReport {
  units: number;
  new_machines: number;
  result: IngestResult;
}

export async function fetchUnits(kind: string, baseUrl: string, secret: any, historyFrom?: Date): Promise<RemoteUnit[]> {
  if (kind === 'traccar') return traccarUnits({ baseUrl, ...secret }, historyFrom);
  if (kind === 'wialon') return wialonUnits({ baseUrl, token: secret.token }, historyFrom);
  if (kind === 'aemp') return aempUnits({ baseUrl, ...secret });
  throw new ConnectorError('config', 'Неизвестный тип подключения: ' + kind);
}

/** Pull units from the external platform, create machines for new units, ingest their data. */
export async function syncConnector(db: Db, connectorId: string, opts: { historyHours?: number } = {}): Promise<SyncReport> {
  const c = (
    await db.query<any>(`select id, org_id, kind, base_url, secret_enc, last_sync_at from connectors where id = $1`, [connectorId])
  ).rows[0];
  if (!c) throw new ConnectorError('config', 'Подключение не найдено');
  const secret = c.secret_enc ? JSON.parse(decryptSecret(c.secret_enc)) : {};
  const historyHours = opts.historyHours ?? (c.last_sync_at ? 26 : 24 * 7);
  const report: SyncReport = {
    units: 0,
    new_machines: 0,
    result: { positions: 0, counters: 0, sensors: 0, faults: 0, duplicates: 0, location_dropped: 0, rejected: [] },
  };
  try {
    const units = await fetchUnits(c.kind, c.base_url, secret, new Date(Date.now() - historyHours * 3600e3));
    report.units = units.length;
    for (const u of units) {
      let src = (
        await db.query<any>(`select id, machine_id, org_id, kind from sources where connector_id = $1 and external_id = $2`, [c.id, u.id])
      ).rows[0];
      if (!src) {
        const machineId = randomUUID();
        await db.query(
          `insert into machines (id, org_id, name, category, make, model) values ($1, $2, $3, 'other', $4, $5)`,
          [machineId, c.org_id, u.name.slice(0, 120), u.make ?? null, u.model ?? null],
        );
        src = { id: randomUUID(), machine_id: machineId, org_id: c.org_id, kind: c.kind };
        await db.query(
          `insert into sources (id, org_id, machine_id, kind, connector_id, external_id, label) values ($1, $2, $3, $4, $5, $6, $7)`,
          [src.id, c.org_id, machineId, c.kind, c.id, u.id, u.name.slice(0, 120)],
        );
        report.new_machines++;
      }
      if (!src.machine_id || u.records.length === 0) continue;
      const r = await ingestForSource(db, src, u.records);
      report.result.positions += r.positions;
      report.result.counters += r.counters;
      report.result.sensors += r.sensors;
      report.result.duplicates += r.duplicates;
      report.result.location_dropped += r.location_dropped;
      report.result.rejected.push(...r.rejected.slice(0, 20));
    }
    await db.query(`update connectors set status = 'ok', last_sync_at = now(), last_error = null where id = $1`, [c.id]);
  } catch (e: any) {
    await db.query(`update connectors set status = 'error', last_error = $2 where id = $1`, [c.id, String(e?.message ?? e).slice(0, 500)]);
    throw e;
  }
  return report;
}
