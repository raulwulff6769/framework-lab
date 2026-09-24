"""Machine model: where the machine is, what the engine does, what its sensors read.

Every number here is a modelling assumption for a demonstration, not a specification of a real
machine: shift times follow typical practice for the season, speeds and fuel rates are in the range
of the named machine classes. The engine values are then encoded into real J1939 frames (stand/can.py).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

M_PER_DEG_LAT = 111_320.0


@dataclass(frozen=True)
class Profile:
    key: str
    idle_rpm: float
    work_rpm: float
    transit_rpm: float
    idle_lph: float
    max_lph: float
    work_kmh: float
    transit_kmh: float
    work_load: float  # % engine load while working
    shifts: tuple[tuple[float, float], ...]  # local hours; an end above 24 runs past midnight
    days: tuple[int, ...]  # 0 = Monday
    odometer: bool = True


PROFILES = {
    "tractor": Profile("tractor", 800, 1900, 1750, 4.5, 62, 9.5, 22, 78, ((7.0, 20.0),), (0, 1, 2, 3, 4, 5, 6)),
    "combine": Profile("combine", 850, 2000, 1800, 5.0, 55, 6.0, 20, 72, ((9.5, 21.0),), (0, 1, 2, 3, 4, 5, 6)),
    "harvester": Profile("harvester", 850, 1750, 1500, 3.5, 22, 1.2, 6, 65, ((7.0, 17.0), (17.5, 23.0)), (0, 1, 2, 3, 4, 5)),
    "forwarder": Profile("forwarder", 850, 1600, 1500, 3.5, 18, 5.0, 8, 55, ((7.0, 17.0), (17.5, 23.0)), (0, 1, 2, 3, 4, 5)),
    "timber_truck": Profile("timber_truck", 650, 1450, 1450, 3.0, 45, 30.0, 60, 60, ((5.5, 20.0),), (0, 1, 2, 3, 4, 5)),
    "excavator": Profile("excavator", 950, 1850, 1400, 5.0, 48, 1.0, 3, 80, ((8.0, 20.0), (20.5, 31.5)), (0, 1, 2, 3, 4, 5, 6), odometer=False),
    "dump_truck": Profile("dump_truck", 750, 1700, 1700, 8.0, 95, 22.0, 32, 70, ((8.0, 20.0), (20.5, 31.5)), (0, 1, 2, 3, 4, 5, 6)),
    "loader": Profile("loader", 850, 1800, 1600, 4.0, 28, 8.0, 15, 60, ((8.0, 19.0),), (0, 1, 2, 3, 4, 5)),
    "dozer": Profile("dozer", 800, 1800, 1500, 5.0, 42, 3.5, 6, 75, ((8.0, 18.0),), (0, 1, 2, 3, 4, 5), odometer=False),
}

# (daily mean, amplitude) of air temperature in late September — illustrative, not climate data
CLIMATE = {"kuban": (19.0, 6.5), "onega": (8.0, 4.0), "granit": (13.0, 6.0), "stroy": (11.0, 5.0)}
# probability of cellular coverage at the work place; forest cutting areas are the weak spot
COVERAGE = {"kuban": 0.99, "onega": 0.62, "granit": 0.98, "stroy": 1.0}
ACTIVITY_RU = {"transit": "переезд", "work": "в работе", "idle": "холостой ход", "parked": "на стоянке"}


def enu(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    return (lon - lon0) * M_PER_DEG_LAT * math.cos(math.radians(lat0)), (lat - lat0) * M_PER_DEG_LAT


def geo(lat0: float, lon0: float, x: float, y: float) -> tuple[float, float]:
    return lat0 + y / M_PER_DEG_LAT, lon0 + x / (M_PER_DEG_LAT * math.cos(math.radians(lat0)))


@dataclass
class Leg:
    """Straight movement between two points (metres east/north of the region base)."""
    a: tuple[float, float]
    b: tuple[float, float]
    kmh: float
    activity: str  # transit | work | idle
    implement: bool = False
    dwell_s: float = 0.0  # stop at b before the next leg (loading, felling, dumping…)


def field_passes(ring: list[list[float]], lat0: float, lon0: float, width: float, offset: float) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Back-and-forth passes one working width apart inside a rectangular field, headlands excluded."""
    xs, ys = zip(*(enu(lat0, lon0, lat, lon) for lon, lat in ring))
    x0, x1, y0, y1 = min(xs) + width, max(xs) - width, min(ys) + 2 * width, max(ys) - 2 * width
    passes, x, up = [], x0 + offset % width, True
    while x < x1:
        passes.append(((x, y0), (x, y1)) if up else ((x, y1), (x, y0)))
        x += width
        up = not up
    return passes


class Plan:
    """The legs of one shift for one machine."""

    def __init__(self, u: dict, fleet: dict, rng: random.Random):
        self.u, self.rng = u, rng
        self.lat0, self.lon0 = fleet["regions"][u["region"]]["base"]
        self.base = (rng.uniform(-40, 40), rng.uniform(-40, 40))
        gf = next((g for g in fleet["geofences"] if g["id"] == u["field"]), None)
        self.ring = gf["ring"] if gf else None
        self.pass_index = rng.randint(0, 40)
        self.offset = rng.uniform(0, 5)

    def area_point(self, margin: float = 60) -> tuple[float, float]:
        if not self.ring:
            return (self.rng.uniform(-300, 300), self.rng.uniform(-300, 300))
        xs, ys = zip(*(enu(self.lat0, self.lon0, lat, lon) for lon, lat in self.ring))
        return (self.rng.uniform(min(xs) + margin, max(xs) - margin), self.rng.uniform(min(ys) + margin, max(ys) - margin))

    def shift(self, hours: float, prof: Profile) -> list[Leg]:
        u, rng = self.u, self.rng
        legs: list[Leg] = []
        k = u["profile"]
        pos = self.base

        def go(to, kmh, activity="transit", implement=False, dwell=0.0):
            nonlocal pos
            legs.append(Leg(pos, to, kmh, activity, implement, dwell))
            pos = to

        budget = hours * 3600
        if k in ("tractor", "combine") and self.ring:
            passes = field_passes(self.ring, self.lat0, self.lon0, u["width_m"] or 8, self.offset)
            go(passes[self.pass_index % len(passes)][0], prof.transit_kmh * rng.uniform(0.85, 1.05))
            used = 0.0
            while used < budget * 0.8:
                a, b = passes[self.pass_index % len(passes)]
                self.pass_index += 1
                if math.dist(pos, a) > 1:
                    go(a, 6.0, "work")  # headland turn with the implement raised
                kmh = prof.work_kmh * rng.uniform(0.9, 1.1)
                go(b, kmh, "work", implement=True)
                used += math.dist(a, b) / (kmh / 3.6) + 25
        elif k == "harvester":
            go(self.area_point(), prof.transit_kmh)
            for _ in range(int(budget / 420)):
                nxt = self.area_point() if rng.random() < 0.12 else (pos[0] + rng.uniform(-25, 25), pos[1] + rng.uniform(-25, 25))
                go(nxt, prof.work_kmh * 2, "work", True, rng.uniform(180, 420))  # felling and processing at each stop
        elif k == "forwarder":
            landing = self.area_point()
            go(landing, prof.transit_kmh)
            for _ in range(int(budget / 1500)):
                go(self.area_point(), prof.work_kmh, "work", False, rng.uniform(300, 700))  # loading logs in the stand
                go(landing, prof.work_kmh * 0.8, "work", False, rng.uniform(240, 420))  # unloading at the roadside
        elif k == "timber_truck":
            mill = (32_000 + rng.uniform(-500, 500), -9_000 + rng.uniform(-500, 500))
            landing = self.area_point()
            for _ in range(max(1, int(budget / 7200))):
                go(landing, prof.work_kmh, dwell=rng.uniform(1500, 2400))  # loading with the crane
                mid = ((landing[0] + mill[0]) / 2 + rng.uniform(-3000, 3000), (landing[1] + mill[1]) / 2 + rng.uniform(-3000, 3000))
                go(mid, prof.transit_kmh)
                go(mill, prof.transit_kmh, dwell=rng.uniform(900, 1500))
                go(mid, prof.transit_kmh)
        elif k == "excavator":
            spot = self.area_point()
            go(spot, prof.transit_kmh)
            for _ in range(int(budget / 1200)):
                go((spot[0] + rng.uniform(-15, 15), spot[1] + rng.uniform(-15, 15)), prof.work_kmh * 2, "work", True, rng.uniform(900, 1300))
        elif k == "dump_truck":
            pit = self.area_point()
            dump = (self.base[0] + rng.uniform(600, 900), self.base[1] + rng.uniform(200, 400))
            for _ in range(int(budget / 780)):
                go(pit, prof.work_kmh, "work", False, rng.uniform(150, 240))
                go(dump, prof.work_kmh * 1.2, "work", False, rng.uniform(50, 80))
        else:  # loader or dozer on a site: short back-and-forth runs
            spot = self.area_point(margin=30)
            go(spot, prof.transit_kmh)
            for _ in range(int(budget / 70)):
                d, ang = rng.uniform(40, 120), rng.uniform(0, math.tau)
                go((spot[0] + d * math.cos(ang), spot[1] + d * math.sin(ang)), prof.work_kmh, "work", k == "dozer", rng.uniform(5, 30))
                go(spot, prof.work_kmh, "work", False, rng.uniform(5, 30))
        go(self.base, prof.transit_kmh * rng.uniform(0.9, 1.05))
        return legs


@dataclass
class State:
    t: int = 0
    lat: float = 0.0
    lon: float = 0.0
    speed_kmh: float = 0.0
    course: float = 0.0
    ignition: bool = False
    engine: bool = False
    rpm: float = 0.0
    load: float = 0.0
    coolant: float = 15.0
    oil_temp: float = 15.0
    oil_kpa: float = 0.0
    fuel_rate: float = 0.0
    fuel_l: float = 0.0
    fuel_used_l: float = 0.0
    hours: float = 0.0
    odo_m: float = 0.0
    gnss_odo_m: float = 0.0
    battery_v: float = 25.2
    ambient: float = 15.0
    implement: bool = False
    activity: str = "на стоянке"
    coverage: bool = True
    sats: int = 0
    hdop: float = 99.0
    faults: list[tuple[int, int, int]] = field(default_factory=list)  # (spn, fmi, occurrence count)


class Machine:
    """Advances one machine through time; `step(t, dt)` must be called with increasing t."""

    def __init__(self, u: dict, fleet: dict, seed: int, start_hours: float):
        self.u = u
        self.prof = PROFILES[u["profile"]]
        self.rng = random.Random(seed)
        self.plan = Plan(u, fleet, self.rng)
        self.tz = fleet["regions"][u["region"]]["utc_offset_h"]
        self.clim = CLIMATE[u["region"]]
        self.forest = u["region"] == "onega"
        tank = u["tank_l"] or 400
        self.s = State(hours=start_hours, odo_m=start_hours * 6500.0 if self.prof.odometer else 0.0,
                       fuel_used_l=start_hours * self.prof.max_lph * 0.45, fuel_l=tank * self.rng.uniform(0.45, 0.9))
        self.legs: list[Leg] = []
        self.leg_i = 0
        self.leg_pos = 0.0
        self.dwell_left = 0.0
        self.dwell_leg: Leg | None = None
        self.shift_end = 0
        self.x, self.y = self.plan.base
        self.scenario: dict[str, int] = {}  # name -> expiry (unix s)
        self.coverage_until = 0
        self.coverage_off_until = 0
        self.events: list[tuple[int, str]] = []  # (t, text) for the stand log
        self.run_s = 0.0  # seconds since the engine started

    # ---------------------------------------------------------------- environment
    def local_hour(self, t: int) -> float:
        return (t / 3600 + self.tz) % 24

    def weekday(self, t: int) -> int:
        return int(((t + self.tz * 3600) // 86400 + 3) % 7)  # 1970-01-01 was a Thursday

    def ambient(self, t: int) -> float:
        mean, amp = self.clim
        return mean + amp * math.sin((self.local_hour(t) - 9) / 24 * math.tau)

    def in_shift(self, t: int) -> float | None:
        """Seconds left in the current shift, or None outside shifts."""
        h, wd = self.local_hour(t), self.weekday(t)
        for a, b in self.prof.shifts:
            if b > 24 and h < b - 24 and (wd - 1) % 7 in self.prof.days:
                return (b - 24 - h) * 3600
            if a <= h < min(b, 24) and wd in self.prof.days:
                return (b - h) * 3600
        return None

    # ---------------------------------------------------------------- scenario commands
    def command(self, name: str, t: int) -> str:
        s = self.s
        tank = self.u["tank_l"] or 400
        if name == "engine_start":
            self.scenario["force_on"] = t + 3600
            self.scenario.pop("force_off", None)
            return "двигатель запущен на 1 час"
        if name == "engine_stop":
            self.scenario["force_off"] = t + 3600
            self.scenario.pop("force_on", None)
            return "двигатель заглушен на 1 час"
        if name == "oil_pressure_drop":
            self.scenario["oil_drop"] = t + 1200
            self.scenario.setdefault("force_on", t + 1200)
            return "давление масла падает на 20 мин; ЭБУ выставит SPN 100 FMI 1"
        if name == "overheat":
            self.scenario["overheat"] = t + 1500
            self.scenario.setdefault("force_on", t + 1500)
            return "перегрев ОЖ на 25 мин; ЭБУ выставит SPN 110 FMI 0"
        if name == "clear_faults":
            for k in ("oil_drop", "overheat"):
                self.scenario.pop(k, None)
            s.faults = []
            return "неисправности сброшены"
        if name == "fuel_drain":
            litres = max(0.0, min(60.0, s.fuel_l - 5))
            s.fuel_l -= litres
            self.events.append((t, f"слив топлива {litres:.0f} л"))
            return f"слито {litres:.0f} л"
        if name == "refuel":
            add = max(0.0, tank * 0.97 - s.fuel_l)
            s.fuel_l += add
            self.events.append((t, f"заправка {add:.0f} л"))
            return f"заправлено {add:.0f} л"
        if name == "coverage_loss":
            self.coverage_off_until = t + 1800
            return "нет сотовой связи 30 мин: записи копятся в памяти трекера"
        if name == "coverage_restore":
            self.coverage_off_until = 0
            self.coverage_until = 0
            return "связь восстановлена: трекер досылает архив"
        if name == "implement_on":
            self.scenario["implement"] = t + 3600
            return "орудие опущено на 1 час"
        if name == "implement_off":
            self.scenario.pop("implement", None)
            return "орудие поднято"
        return "команда не поддерживается моделью"

    def active(self, name: str, t: int) -> bool:
        exp = self.scenario.get(name)
        if exp is None:
            return False
        if t > exp:
            self.scenario.pop(name, None)
            return False
        return True

    # ---------------------------------------------------------------- simulation
    def _advance(self, dt: float) -> tuple[float, str, bool]:
        if self.dwell_left > 0 and self.dwell_leg:
            self.dwell_left -= dt
            leg = self.dwell_leg
            return 0.0, "work" if leg.activity == "work" else "idle", leg.implement and leg.activity == "work"
        if self.leg_i >= len(self.legs):
            return 0.0, "parked", False
        leg = self.legs[self.leg_i]
        length = math.dist(leg.a, leg.b)
        v = leg.kmh / 3.6 * self.rng.uniform(0.93, 1.07)
        self.leg_pos += v * dt
        if self.leg_pos >= length:
            self.x, self.y = leg.b
            self.leg_i += 1
            self.leg_pos = 0.0
            self.dwell_left, self.dwell_leg = leg.dwell_s, leg
        else:
            k = self.leg_pos / max(length, 1e-6)
            self.x, self.y = leg.a[0] + (leg.b[0] - leg.a[0]) * k, leg.a[1] + (leg.b[1] - leg.a[1]) * k
        if length > 0.5:
            self.s.course = math.degrees(math.atan2(leg.b[0] - leg.a[0], leg.b[1] - leg.a[1])) % 360
        return v * 3.6, leg.activity, leg.implement

    def step(self, t: int, dt: float) -> State:
        s, p, rng = self.s, self.prof, self.rng
        tank = self.u["tank_l"] or 400
        s.t = t
        s.ambient = self.ambient(t)
        left = self.in_shift(t)
        if left is not None and self.leg_i >= len(self.legs) and self.dwell_left <= 0 and t >= self.shift_end:
            self.legs = self.plan.shift(left / 3600, p)
            self.leg_i, self.leg_pos = 0, 0.0
            self.shift_end = t + int(left)
            if s.fuel_l < tank * 0.4:  # fuel truck at the base before the shift
                add = tank * rng.uniform(0.9, 0.97) - s.fuel_l
                s.fuel_l += add
                self.events.append((t, f"заправка {add:.0f} л перед сменой"))
        lunch = left is not None and 12.5 <= self.local_hour(t) < 13.2 and p.key not in ("excavator", "dump_truck")
        prev = (self.x, self.y)  # before _advance moves the machine, or the odometers never grow
        kmh, act, implement = (0.0, "parked", False) if lunch else self._advance(dt)
        implement = implement or self.active("implement", t)
        running = act != "parked" or self.active("force_on", t)
        if self.active("force_off", t):
            running, kmh, act = False, 0.0, "parked"
        s.speed_kmh = kmh if running else 0.0
        s.ignition = s.engine = running
        s.implement = implement and running
        s.activity = ACTIVITY_RU[act if running and act != "parked" else ("idle" if running else "parked")]
        self.run_s = self.run_s + dt if running else 0.0
        if running:
            if self.run_s <= dt:  # the starter spins the engine up to idle within a couple of seconds
                s.rpm = max(s.rpm, p.idle_rpm * 0.8)
            target = {"work": p.work_rpm, "transit": p.transit_rpm}.get(act, p.idle_rpm)
            s.rpm += (target * rng.uniform(0.97, 1.03) - s.rpm) * min(1.0, dt / 4)
            load = {"work": p.work_load, "transit": 45.0}.get(act, 12.0) * rng.uniform(0.9, 1.1)
            s.load += (load - s.load) * min(1.0, dt / 6)
            s.fuel_rate = p.idle_lph + (p.max_lph - p.idle_lph) * s.load / 100 * rng.uniform(0.95, 1.05)
            hot = 112.0 if self.active("overheat", t) else 86.0 + s.load / 100 * 6
            s.coolant += (hot - s.coolant) * min(1.0, dt / 420)
            s.oil_temp += (s.coolant + 4 - s.oil_temp) * min(1.0, dt / 600)
            nominal = 150 + (s.rpm - p.idle_rpm) / max(1.0, p.work_rpm - p.idle_rpm) * 300 - max(0.0, s.oil_temp - 90) * 2
            s.oil_kpa = max(20.0, nominal * (0.22 if self.active("oil_drop", t) else 1.0) * rng.uniform(0.97, 1.03))
            s.battery_v = 27.9 + rng.uniform(-0.15, 0.15)
            s.hours += dt / 3600
            burn = s.fuel_rate * dt / 3600
            s.fuel_used_l += burn
            s.fuel_l = max(0.0, s.fuel_l - burn)
        else:
            s.rpm = s.load = s.fuel_rate = s.oil_kpa = 0.0
            s.coolant += (s.ambient - s.coolant) * min(1.0, dt / 2400)
            s.oil_temp += (s.ambient - s.oil_temp) * min(1.0, dt / 3000)
            s.battery_v = 25.3 + rng.uniform(-0.05, 0.05)
        # faults raised by the engine controller from the state
        active = []
        # like a real ECU, low oil pressure is judged only on a warmed-up idle, not while cranking
        if running and self.run_s > 15 and s.rpm > p.idle_rpm * 0.9 and s.oil_kpa < 90:
            active.append((100, 1))
        if running and s.coolant > 106:
            active.append((110, 0))
        for spn, fmi in active:
            if not any(f[0] == spn and f[1] == fmi for f in s.faults):
                s.faults.append((spn, fmi, 1))
                self.events.append((t, f"ЭБУ: активная ошибка SPN {spn} FMI {fmi}"))
        s.faults = [f for f in s.faults if (f[0], f[1]) in active]
        # GNSS: canopy degrades accuracy and the satellite count
        canopy = self.forest and act == "work"
        sigma = (4.0 if canopy else 1.5) * rng.uniform(0.8, 1.2)
        s.lat, s.lon = geo(self.plan.lat0, self.plan.lon0, self.x + rng.gauss(0, sigma), self.y + rng.gauss(0, sigma))
        s.sats = rng.randint(7, 11) if canopy else rng.randint(14, 21)
        s.hdop = round(rng.uniform(1.3, 2.6) if canopy else rng.uniform(0.6, 1.0), 1)
        moved = math.dist(prev, (self.x, self.y))
        s.gnss_odo_m += moved
        if p.odometer:
            s.odo_m += moved
        # cellular coverage: forest cutting areas lose the network for tens of minutes
        if t < self.coverage_off_until:
            s.coverage = False
        elif t >= self.coverage_until:
            s.coverage = rng.random() < (COVERAGE[self.u["region"]] if act == "work" else 0.995)
            self.coverage_until = t + (rng.randint(300, 1800) if s.coverage else rng.randint(600, 3000))
        return s
