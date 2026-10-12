/*
 * © 2025–2026 Young Tai Kang. All rights reserved.
 * Licensed to JNF AM LLC for internal use.
 */
/* ============================================================
 * JNFAM Overtime — Google Apps Script backend (Google Sheets store)
 *
 * SETUP (한 번만 / one time)
 *  1. 새 Google 스프레드시트 생성 (예: "JNFAM OT Data")
 *  2. 확장 프로그램 › Apps Script › 이 파일 전체를 Code.gs에 붙여넣기
 *  3. 함수 목록에서 setup 실행 → 권한 승인 (시트·메일·Time Clock 시트 읽기)
 *  4. testTimeClock 실행 → 로그에 출퇴근 기록 건수가 나오면 연동 OK
 *  5. 배포 › 새 배포 › 웹 앱 — 실행: 나(Me), 액세스: 모든 사용자(Anyone)
 *  6. 배포 URL(…/exec)을 index.html 의 OT_CONFIG.API_URL 에 입력
 *  ※ 코드 수정 후에는 "배포 관리 › 수정 › 새 버전"으로 재배포해야 반영됩니다.
 * ============================================================ */

/* ============================================================
 * JNFAM Overtime — shared core (runs in browser demo AND Apps Script)
 * Pure logic + API handlers. Storage is injected via `store`.
 * ============================================================ */
var OTCore = (function () {
  'use strict';

  var VERSION = '1.0.0';

  var STATUS = {
    PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', VERIFIED: 'VERIFIED', CPA: 'CPA', EXCLUDED: 'EXCLUDED'
  };

  var COLUMNS = {
    Employees: ['id', 'name', 'nameEn', 'timeClockName', 'email', 'dept', 'rate', 'roles', 'pin', 'active', 'schedStart', 'schedEnd'],
    Requests: ['id', 'groupId', 'empId', 'empName', 'date', 'start', 'end', 'breakMin', 'otType', 'description',
      'hours', 'premium', 'multiplier', 'status', 'ack', 'submittedAt', 'decidedAt', 'decidedBy', 'decidedByName',
      'decisionComment', 'actualIn', 'actualOut', 'actualHours', 'verifyResult', 'recognizedHours', 'rate', 'pay',
      'verifyNote', 'verifiedAt', 'verifiedBy', 'docId', 'lateEntry', 'lateReason', 'preApproved', 'source', 'preMethod', 'preBy'],
    Holidays: ['date', 'name'],
    Settings: ['key', 'value'],
    Docs: ['id', 'month', 'createdAt', 'createdBy', 'requestIds', 'totalHours', 'totalPay', 'status', 'note', 'periodFrom', 'periodTo'],
    Log: ['ts', 'user', 'action', 'target', 'detail']
  };

  var DEFAULT_SETTINGS = {
    companyName: 'JNF AM LLC',
    address: '825 Great SW Pkwy, South Fulton, GA 30336',
    phone: '770 727 8061',
    weekdayMultiplier: '1',
    premiumMultiplier: '1.5',
    premiumSaturday: 'TRUE',
    premiumSunday: 'FALSE',
    graceMinutes: '10',
    reviewMinutes: '15',
    employeeRequests: 'FALSE',
    startDate: '2026-09-25',
    cpaName: '',
    cpaEmail: '',
    adminEmail: '',
    ccEmail: '',
    appUrl: '',
    otTypes: '배관 작업|Piping work\n생산 작업|Production\n출하·선적|Shipping / Loading\n설비 보수|Maintenance\n재고·창고|Inventory / Warehouse\n기타|Other',
    timeClockSheetId: '1vkmFYoxJji64zWKL2d3-L6nQ-OoVfg-TAjGJY6HOPPg',
    timeClockSheetName: 'TimeLog'
  };

  /* ---------------- pure helpers ---------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function toMin(t) {
    if (!t) return NaN;
    var p = String(t).trim().split(':');
    return Number(p[0]) * 60 + Number(p[1] || 0) + Number(p[2] || 0) / 60;
  }
  function minToHHMM(m) {
    m = Math.round(m);
    var d = Math.floor(m / 1440); m = m - d * 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60) + (d > 0 ? ' (+' + d + ')' : '');
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function weekday(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); } // 0=Sun
  function isTrue(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === '1' || v === 1; }

  /** Net OT hours for a window. end <= start means it crosses midnight. */
  function calcHours(start, end, breakMin) {
    var s = toMin(start), e = toMin(end);
    if (isNaN(s) || isNaN(e)) return 0;
    if (e <= s) e += 1440;
    return round2(Math.max(0, (e - s - (Number(breakMin) || 0))) / 60);
  }
  function windowOf(req) {
    var s = toMin(req.start), e = toMin(req.end);
    if (e <= s) e += 1440;
    return { s: s, e: e };
  }

  function holidaySet(holidays) {
    var m = {};
    (holidays || []).forEach(function (h) { if (h.date) m[String(h.date).slice(0, 10)] = h.name || true; });
    return m;
  }
  function isPremiumDay(dateStr, holidays, settings) {
    var wd = weekday(dateStr);
    if (wd === 6 && isTrue(settings.premiumSaturday)) return true;
    if (wd === 0 && isTrue(settings.premiumSunday)) return true;
    return !!holidaySet(holidays)[dateStr];
  }
  function multiplierFor(dateStr, holidays, settings) {
    return isPremiumDay(dateStr, holidays, settings) ? Number(settings.premiumMultiplier) || 1.5 : Number(settings.weekdayMultiplier) || 1;
  }

  /** US federal holidays (observed) for a year. */
  function federalHolidays(year) {
    function nth(month, dow, n) { // n=-1 last
      if (n > 0) {
        var d = new Date(Date.UTC(year, month, 1));
        var add = (dow - d.getUTCDay() + 7) % 7 + (n - 1) * 7;
        d.setUTCDate(1 + add); return d;
      }
      var last = new Date(Date.UTC(year, month + 1, 0));
      last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7));
      return last;
    }
    function fixed(month, day) {
      var d = new Date(Date.UTC(year, month, day));
      if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
      else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      return d;
    }
    function fmt(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
    return [
      [fixed(0, 1), "New Year's Day"], [nth(0, 1, 3), 'Martin Luther King Jr. Day'],
      [nth(1, 1, 3), "Presidents' Day"], [nth(4, 1, -1), 'Memorial Day'],
      [fixed(5, 19), 'Juneteenth'], [fixed(6, 4), 'Independence Day'],
      [nth(8, 1, 1), 'Labor Day'], [nth(9, 1, 2), 'Columbus Day'],
      [fixed(10, 11), 'Veterans Day'], [nth(10, 4, 4), 'Thanksgiving Day'],
      [fixed(11, 25), 'Christmas Day']
    ].map(function (x) { return { date: fmt(x[0]), name: x[1] }; });
  }

  /**
   * Match Time Clock punches against an approved OT window.
   * punches: [{date:'YYYY-MM-DD', time:'H:MM:SS', type:'IN'|'OUT'}] for ONE employee.
   */
  var MAX_SHIFT = 18 * 60; // an IN/OUT pair longer than this is treated as a missing punch
  function buildIntervals(punches, date) {
    var d0 = date, d1 = addDays(date, 1);
    var pts = (punches || []).filter(function (p) { return p.date === d0 || p.date === d1; })
      .map(function (p) {
        return { m: (p.date === d0 ? 0 : 1440) + toMin(p.time), type: String(p.type).toUpperCase() };
      }).filter(function (p) { return !isNaN(p.m); })
      .sort(function (a, b) { return a.m - b.m; });
    var intervals = [], anomalies = [], open = null;
    pts.forEach(function (p) {
      if (p.type === 'IN') {
        if (open) {
          if (p.m - open.m > MAX_SHIFT || p.m >= 1440) { if (open.m < 1440) anomalies.push('MISSING_OUT'); open = p; }
          else if (open.m < 1440) anomalies.push('DOUBLE_IN');
        } else open = p;
      } else if (p.type === 'OUT') {
        if (open && p.m - open.m <= MAX_SHIFT) { intervals.push({ s: open.m, e: p.m }); open = null; }
        else if (open) { if (open.m < 1440) anomalies.push('MISSING_OUT'); open = null; }
        else if (p.m < 1440) anomalies.push('OUT_WITHOUT_IN');
      }
    });
    var openIn = open && open.m < 1440 ? open.m : null;
    if (open && open.m < 1440 && anomalies.indexOf('MISSING_OUT') < 0) anomalies.push('MISSING_OUT');
    // keep only intervals that start on the date
    intervals = intervals.filter(function (iv) { return iv.s < 1440; });
    return { intervals: intervals, anomalies: anomalies, openIn: openIn };
  }

  function matchPunches(punches, req, graceMinutes) {
    var b = buildIntervals(punches, req.date);
    var intervals = b.intervals, anomalies = b.anomalies;

    var w = windowOf(req);
    var overlap = 0;
    intervals.forEach(function (iv) { overlap += Math.max(0, Math.min(iv.e, w.e) - Math.max(iv.s, w.s)); });

    var gross = w.e - w.s;
    var net = calcHours(req.start, req.end, req.breakMin);
    var grace = Number(graceMinutes) || 0;
    var result, recognized;
    if (!intervals.length && !anomalies.length) { result = 'NO_RECORD'; recognized = 0; }
    else if (overlap >= gross - grace) { result = 'OK'; recognized = net; }
    else if (overlap <= 0) { result = 'NO_OVERLAP'; recognized = 0; }
    else { result = 'PARTIAL'; recognized = round2(Math.max(0, Math.min(net, (overlap - (Number(req.breakMin) || 0)) / 60))); }
    if (anomalies.length && result === 'OK') result = 'CHECK';
    else if (anomalies.length && result !== 'NO_RECORD') result = result === 'PARTIAL' ? 'PARTIAL' : 'CHECK';
    if (anomalies.indexOf('MISSING_OUT') >= 0) result = 'CHECK';

    var actualIn = intervals.length ? minToHHMM(intervals[0].s) : '';
    var actualOut = intervals.length ? minToHHMM(intervals[intervals.length - 1].e) : '';
    return {
      intervals: intervals.map(function (iv) { return minToHHMM(iv.s) + '–' + minToHHMM(iv.e); }),
      actualIn: actualIn, actualOut: actualOut,
      overlapHours: round2(overlap / 60),
      anomalies: anomalies, result: result, recognizedHours: recognized, approvedHours: net
    };
  }

  function hhmm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }

  /**
   * OT candidates straight from the Time Clock (one row per employee-day).
   * Weekday: time after scheduled end (+ time before schedStart-60). Off day / holiday: all worked time.
   */
  function clockCandidates(punchesByEmp, employees, holidays, settings, month) {
    var min = Number(settings.reviewMinutes) || 15;
    var out = [];
    employees.forEach(function (emp) {
      var ps = punchesByEmp[emp.id] || [];
      var dates = {};
      ps.forEach(function (p) { if (String(p.date).slice(0, 7) === month && (!settings.startDate || p.date >= settings.startDate)) dates[p.date] = 1; });
      Object.keys(dates).sort().forEach(function (date) {
        var b = buildIntervals(ps, date), ivs = b.intervals;
        var wd = weekday(date);
        var offDay = wd === 0 || wd === 6 || isPremiumDay(date, holidays, settings);
        var schedS = toMin(emp.schedStart || '09:00'), schedE = toMin(emp.schedEnd || '17:00');
        var segs = [];
        ivs.forEach(function (iv) {
          if (offDay) { segs.push({ s: iv.s, e: iv.e }); return; }
          if (iv.s < schedS - 60) segs.push({ s: iv.s, e: Math.min(iv.e, schedS - 60) });
          if (iv.e > schedE) segs.push({ s: Math.max(iv.s, schedE), e: iv.e });
        });
        var mins = segs.reduce(function (a, x) { return a + Math.max(0, x.e - x.s); }, 0);
        if (mins < min && !b.anomalies.length) return;
        if (!ivs.length && !b.anomalies.length) return;
        var s0 = segs.length ? Math.min.apply(null, segs.map(function (x) { return x.s; })) : 0;
        var e0 = segs.length ? Math.max.apply(null, segs.map(function (x) { return x.e; })) : 0;
        out.push({
          key: emp.id + '|' + date, empId: emp.id, empName: emp.name, date: date, offDay: offDay,
          sched: (emp.schedStart || '09:00') + '–' + (emp.schedEnd || '17:00'),
          punches: ivs.map(function (iv) { return minToHHMM(iv.s) + '–' + minToHHMM(iv.e); }).concat(b.openIn != null ? [minToHHMM(b.openIn) + '–?'] : []).join(', '),
          anomalies: b.anomalies,
          otStart: segs.length ? hhmm(s0) : '', otEnd: segs.length ? hhmm(e0) : '',
          otLabel: segs.map(function (x) { return minToHHMM(x.s) + '–' + minToHHMM(x.e); }).join(', '),
          otHours: round2(mins / 60)
        });
      });
    });
    return out;
  }

  /**
   * Extra time in Time Clock NOT covered by any approved request (not recognized).
   * Weekday: time worked after scheduled end (and before schedStart - 60min).
   * Premium day / weekend: all worked time.
   */
  function unapprovedExtra(punchesByEmp, employees, requests, holidays, settings, month) {
    var grace = Number(settings.reviewMinutes) || 15;
    var out = [];
    employees.forEach(function (emp) {
      var ps = punchesByEmp[emp.id] || [];
      var dates = {};
      ps.forEach(function (p) { if (String(p.date).slice(0, 7) === month) dates[p.date] = 1; });
      Object.keys(dates).sort().forEach(function (date) {
        var ivs = buildIntervals(ps, date).intervals;
        var label = ivs.map(function (iv) { return minToHHMM(iv.s) + '–' + minToHHMM(iv.e); }).join(', ');
        if (!ivs.length) return;
        var wd = weekday(date);
        var offDay = wd === 0 || wd === 6 || isPremiumDay(date, holidays, settings);
        var schedS = toMin(emp.schedStart || '09:00'), schedE = toMin(emp.schedEnd || '17:00');
        var extra = [];
        ivs.forEach(function (iv) {
          if (offDay) { extra.push({ s: iv.s, e: iv.e }); return; }
          if (iv.e > schedE) extra.push({ s: Math.max(iv.s, schedE), e: iv.e });
          if (iv.s < schedS - 60) extra.push({ s: iv.s, e: Math.min(iv.e, schedS - 60) });
        });
        // subtract windows of approved/verified/cpa requests
        var covered = requests.filter(function (r) {
          return r.empId === emp.id && r.date === date && [STATUS.APPROVED, STATUS.VERIFIED, STATUS.CPA].indexOf(r.status) >= 0;
        }).map(windowOf);
        var mins = 0;
        extra.forEach(function (x) {
          var segs = [x];
          covered.forEach(function (c) {
            var next = [];
            segs.forEach(function (sg) {
              if (c.e <= sg.s || c.s >= sg.e) { next.push(sg); return; }
              if (c.s > sg.s) next.push({ s: sg.s, e: c.s });
              if (c.e < sg.e) next.push({ s: c.e, e: sg.e });
            });
            segs = next;
          });
          segs.forEach(function (sg) { mins += Math.max(0, sg.e - sg.s); });
        });
        if (mins > grace) {
          out.push({
            empId: emp.id, empName: emp.name, date: date, offDay: offDay,
            punches: label, extraHours: round2(mins / 60),
            hasRequest: requests.some(function (r) { return r.empId === emp.id && r.date === date; })
          });
        }
      });
    });
    return out;
  }

  /* ---------------- API ---------------- */
  function create(store) {
    function err(code, msg) { var e = new Error(msg || code); e.code = code; throw e; }

    function settings() {
      var s = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
      store.read('Settings').forEach(function (r) { if (r.key) s[r.key] = r.value; });
      return s;
    }
    function employees() { return store.read('Employees'); }
    function holidays() { return store.read('Holidays').filter(function (h) { return h.date; }); }
    function rolesOf(emp) { return String(emp.roles || '').split(/[,\s]+/).filter(Boolean); }
    function has(emp, role) { return rolesOf(emp).indexOf(role) >= 0; }
    function log(user, action, target, detail) {
      try { store.append('Log', { ts: store.nowET(), user: user ? user.id : '', action: action, target: target || '', detail: typeof detail === 'string' ? detail : JSON.stringify(detail || '') }); } catch (e) { }
    }

    function seedIfEmpty() {
      if (employees().length) return;
      var emps = [
        { id: 'admin', name: '관리자', nameEn: 'Administrator', timeClockName: '', email: '', dept: 'Admin', rate: '0', roles: 'admin,approver', pin: '1234', active: 'TRUE', schedStart: '09:00', schedEnd: '17:00' },
        { id: 'E001', name: '김태희', nameEn: 'TaeHee Kim', timeClockName: '김태희', email: '', dept: 'Operations', rate: '30', roles: 'employee', pin: '0000', active: 'TRUE', schedStart: '09:00', schedEnd: '17:00' },
        { id: 'E002', name: '이무원', nameEn: 'MooWon Lee', timeClockName: '이무원', email: '', dept: 'Operations', rate: '30', roles: 'employee', pin: '0000', active: 'TRUE', schedStart: '09:00', schedEnd: '17:00' },
        { id: 'E003', name: '최재수', nameEn: 'Jaesoo Choi', timeClockName: '최재수', email: '', dept: 'Operations', rate: '30', roles: 'employee', pin: '0000', active: 'TRUE', schedStart: '09:00', schedEnd: '17:00' },
        { id: 'E004', name: 'MASUD KHANDAKER', nameEn: 'MASUD KHANDAKER', timeClockName: 'MASUD KHANDAKER', email: '', dept: 'Production', rate: '30', roles: 'employee', pin: '0000', active: 'TRUE', schedStart: '08:00', schedEnd: '16:00' },
        { id: 'E005', name: 'JOHNETTE', nameEn: 'JOHNETTE K', timeClockName: 'JOHNETTE', email: '', dept: 'Production', rate: '30', roles: 'employee', pin: '0000', active: 'TRUE', schedStart: '08:00', schedEnd: '16:00' }
      ];
      store.replaceAll('Employees', emps);
      if (!store.read('Holidays').length) store.replaceAll('Holidays', [{ date: '2026-01-01', name: "New Year's Day" }]);
    }

    function auth(p) {
      var empId = p && p.token ? store.sessionGet(p.token) : null;
      if (!empId) err('AUTH', 'Session expired. Please log in again.');
      var u = employees().filter(function (e) { return e.id === empId && isTrue(e.active); })[0];
      if (!u) err('AUTH', 'User not found');
      return u;
    }
    function need(u, role) { if (!has(u, role) && !has(u, 'admin')) err('FORBIDDEN', 'Permission denied'); }

    function publicEmp(e, full) {
      var o = { id: e.id, name: e.name, nameEn: e.nameEn, dept: e.dept, roles: e.roles, active: e.active, schedStart: e.schedStart, schedEnd: e.schedEnd };
      if (full) { o.timeClockName = e.timeClockName; o.email = e.email; o.rate = e.rate; o.hasPin = !!e.pin; }
      return o;
    }

    function expireStale() {
      var now = store.nowET();
      store.read('Requests').forEach(function (r) {
        if ((r.status === STATUS.PENDING) && (r.date + 'T' + r.start) <= now.slice(0, 16)) {
          r.status = STATUS.EXPIRED;
          r.decisionComment = (r.decisionComment ? r.decisionComment + ' / ' : '') + 'Auto-expired: not approved before start';
          store.upsert('Requests', 'id', r);
        }
      });
    }

    function mailApprovers(reqs, user, s) {
      var to = employees().filter(function (e) { return isTrue(e.active) && (has(e, 'approver')) && e.email && e.id !== user.id; })
        .map(function (e) { return e.email; });
      if (s.adminEmail) to.push(s.adminEmail);
      to = to.filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (!to.length) return;
      var rows = reqs.map(function (r) {
        return '<tr><td>' + r.date + '</td><td>' + r.start + '–' + r.end + '</td><td>' + r.hours + 'h</td><td>' + esc(r.otType) + '</td><td>' + esc(r.description) + '</td></tr>';
      }).join('');
      var html = '<div style="font-family:Arial,sans-serif;font-size:14px">'
        + '<p><b>' + esc(user.name) + '</b> 님이 오버타임 사전 승인을 요청했습니다. / ' + esc(user.nameEn || user.name) + ' submitted an overtime pre-approval request.</p>'
        + '<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Date</th><th>Time</th><th>Hours</th><th>Type</th><th>Description</th></tr>' + rows + '</table>'
        + (reqs.some(function (r) { return r.lateEntry === 'Y'; }) ? '<p style="color:#b42318">⚠ 시작 시각 이후 등록된 사후 신청이 포함되어 있습니다. / Includes entries submitted after the start time (post-entry).</p>' : '')
        + '<p style="color:#b45309">※ 시작 시각 이후 승인 시 "사후 승인"으로 표시됩니다. / Approvals after the start time are flagged as post-approved.</p>'
        + (s.appUrl ? '<p><a href="' + s.appUrl + '">' + s.appUrl + '</a></p>' : '') + '</div>';
      store.sendMail(to.join(','), '[JNFAM OT] 승인 요청 / Approval request — ' + (user.nameEn || user.name), html, s.ccEmail);
    }
    function mailApplicant(r, decider, s) {
      var emp = employees().filter(function (e) { return e.id === r.empId; })[0];
      if (!emp || !emp.email) return;
      var ok = r.status === STATUS.APPROVED;
      var html = '<div style="font-family:Arial,sans-serif;font-size:14px">'
        + '<p>오버타임 신청이 <b>' + (ok ? '승인' : '반려') + '</b>되었습니다. / Your overtime request was <b>' + (ok ? 'APPROVED' : 'REJECTED') + '</b>.</p>'
        + '<p>' + r.date + ' ' + r.start + '–' + r.end + ' (' + r.hours + 'h) · ' + esc(r.otType) + '</p>'
        + (ok && r.preApproved === 'N' ? '<p style="color:#b42318">⚠ 사후 승인 / Post-approved (approved after start)</p>' : '')
        + (r.decisionComment ? '<p>Comment: ' + esc(r.decisionComment) + '</p>' : '')
        + '<p>Approver: ' + esc(decider.nameEn || decider.name) + ' · ' + r.decidedAt + ' ET</p></div>';
      store.sendMail(emp.email, '[JNFAM OT] ' + (ok ? '승인 Approved' : '반려 Rejected') + ' — ' + r.date, html, '');
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    function punchesFor(from, to) {
      var emps = employees();
      var byName = {};
      emps.forEach(function (e) { if (e.timeClockName) byName[String(e.timeClockName).trim()] = e.id; });
      var raw = store.timelog(from, addDays(to, 1));
      var by = {};
      raw.forEach(function (p) {
        var id = byName[String(p.name).trim()];
        if (!id) return;
        (by[id] = by[id] || []).push({ date: p.date, time: p.time, type: p.type });
      });
      return by;
    }

    var handlers = {
      ping: function () { return { ok: true, version: VERSION, nowET: store.nowET() }; },

      loginList: function () {
        seedIfEmpty();
        return { employees: employees().filter(function (e) { return isTrue(e.active); }).map(function (e) { return { id: e.id, name: e.name, nameEn: e.nameEn }; }) };
      },

      login: function (p) {
        seedIfEmpty();
        var u = employees().filter(function (e) { return e.id === p.empId && isTrue(e.active); })[0];
        if (!u || String(u.pin) !== String(p.pin)) err('LOGIN', 'Invalid ID or PIN');
        var token = store.uuid();
        store.sessionSet(token, u.id);
        log(u, 'login');
        return { token: token };
      },

      bootstrap: function (p) {
        var u = auth(p);
        var isAdmin = has(u, 'admin'), isApprover = has(u, 'approver') || isAdmin;
        var reqs = store.read('Requests');
        if (!isApprover) reqs = reqs.filter(function (r) { return r.empId === u.id; });
        if (!isAdmin) reqs = reqs.map(function (r) { if (r.empId !== u.id) { var c = {}; for (var k in r) c[k] = r[k]; c.rate = ''; c.pay = ''; return c; } return r; });
        return {
          user: publicEmp(u, true),
          roles: rolesOf(u),
          employees: employees().map(function (e) { return publicEmp(e, isAdmin); }),
          settings: settings(),
          holidays: holidays(),
          requests: reqs,
          docs: isAdmin ? store.read('Docs') : [],
          nowET: store.nowET()
        };
      },

      submit: function (p) {
        var u = auth(p);
        if (!p.ack) err('ACK', 'Pre-approval policy must be acknowledged');
        var lines = p.lines || [];
        if (!lines.length) err('EMPTY', 'No lines');
        var s = settings(), hol = holidays(), now = store.nowET();
        var empId = u.id;
        var mine = store.read('Requests').filter(function (r) {
          return r.empId === empId && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0;
        });
        var groupId = 'G' + now.replace(/\D/g, '').slice(2, 14);
        var created = [];
        return store.lock(function () {
          var seq = store.read('Requests').length;
          lines.forEach(function (l, i) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date || '')) err('DATE', 'Invalid date (line ' + (i + 1) + ')');
            if (!/^\d{1,2}:\d{2}$/.test(l.start || '') || !/^\d{1,2}:\d{2}$/.test(l.end || '')) err('TIME', 'Invalid time (line ' + (i + 1) + ')');
            var start = pad(Math.floor(toMin(l.start) / 60)) + ':' + pad(toMin(l.start) % 60);
            var end = pad(Math.floor(toMin(l.end) / 60)) + ':' + pad(toMin(l.end) % 60);
            var late = (l.date + 'T' + start) <= now.slice(0, 16);
            if (late && !String(l.lateReason || '').trim()) err('LATE_REASON', 'LATE_REASON:' + l.date + ' ' + start);
            var hours = calcHours(start, end, l.breakMin);
            if (hours <= 0) err('HOURS', 'OT hours must be > 0 (line ' + (i + 1) + ')');
            if (hours > 16) err('HOURS', 'OT hours too long (line ' + (i + 1) + ')');
            if (!String(l.description || '').trim()) err('DESC', 'Description required (line ' + (i + 1) + ')');
            var w = windowOf({ start: start, end: end });
            mine.concat(created).forEach(function (r) {
              if (r.date !== l.date) return;
              var o = windowOf(r);
              if (w.s < o.e && o.s < w.e) err('OVERLAP', 'OVERLAP:' + l.date);
            });
            seq++;
            var r = {
              id: 'OT' + now.slice(2, 4) + now.slice(5, 7) + '-' + ('000' + seq).slice(-4) + '-' + store.uuid().slice(0, 4).toUpperCase(),
              groupId: groupId, empId: empId, empName: u.name, date: l.date, start: start, end: end,
              breakMin: String(Number(l.breakMin) || 0), otType: String(l.otType || ''), description: String(l.description || '').trim(),
              hours: String(hours), premium: isPremiumDay(l.date, hol, s) ? 'Y' : 'N', multiplier: String(multiplierFor(l.date, hol, s)),
              status: STATUS.PENDING, ack: 'TRUE', submittedAt: now,
              lateEntry: late ? 'Y' : 'N', lateReason: late ? String(l.lateReason).trim() : ''
            };
            created.push(r);
          });
          created.forEach(function (r) { store.append('Requests', r); });
          log(u, 'submit', groupId, created.map(function (r) { return r.id; }).join(','));
          try { mailApprovers(created, u, s); } catch (e) { log(u, 'mail-error', groupId, String(e)); }
          return { created: created };
        });
      },

      cancel: function (p) {
        var u = auth(p);
        return store.lock(function () {
          var r = store.read('Requests').filter(function (x) { return x.id === p.id; })[0];
          if (!r) err('NOTFOUND');
          if (r.empId !== u.id && !has(u, 'admin')) err('FORBIDDEN');
          var now = store.nowET();
          if (!(r.status === STATUS.PENDING || (r.status === STATUS.APPROVED && ((r.date + 'T' + r.start) > now.slice(0, 16) || has(u, 'admin'))))) err('STATE', 'Cannot cancel in this state');
          r.status = STATUS.CANCELLED;
          r.decisionComment = (r.decisionComment ? r.decisionComment + ' / ' : '') + 'Cancelled by ' + u.name + ' ' + now;
          store.upsert('Requests', 'id', r);
          log(u, 'cancel', r.id);
          return { request: r };
        });
      },

      decide: function (p) {
        var u = auth(p);
        need(u, 'approver');
        var s = settings();
        return store.lock(function () {
          var r = store.read('Requests').filter(function (x) { return x.id === p.id; })[0];
          if (!r) err('NOTFOUND');
          if (r.empId === u.id) err('SELF', 'Self-approval is not allowed');
          if (r.status !== STATUS.PENDING) err('STATE', 'Already processed: ' + r.status);
          var now = store.nowET();
          if (p.decision === 'approve') {
            r.status = STATUS.APPROVED;
            r.preApproved = (r.date + 'T' + r.start) > now.slice(0, 16) ? 'Y' : 'N';
          } else {
            if (!String(p.comment || '').trim()) err('COMMENT', 'Reason required');
            r.status = STATUS.REJECTED;
          }
          r.decidedAt = now; r.decidedBy = u.id; r.decidedByName = u.nameEn || u.name;
          r.decisionComment = String(p.comment || '');
          store.upsert('Requests', 'id', r);
          log(u, p.decision, r.id);
          try { mailApplicant(r, u, s); } catch (e) { log(u, 'mail-error', r.id, String(e)); }
          return { request: r };
        });
      },

      /** Suggested verification results for approved requests in a month + unapproved extra time */
      verifyPreview: function (p) {
        var u = auth(p);
        need(u, 'admin');
        var from, to;
        if (p.from && p.to) { from = p.from; to = p.to; }
        else { from = p.month + '-01'; to = addDays(addDays(p.month + '-28', 4).slice(0, 7) + '-01', -1); }
        if (from > to) err('PERIOD', 'Invalid period');
        var months = [];
        for (var mm = from.slice(0, 7); mm <= to.slice(0, 7); mm = addDays(mm + '-28', 4).slice(0, 7)) months.push(mm);
        var s = settings(), hol = holidays();
        var punches = punchesFor(from, to);
        var inR = function (d) { return d >= from && d <= to; };
        var reqs = store.read('Requests').filter(function (r) { return inR(String(r.date)); });
        var rows = reqs.filter(function (r) { return [STATUS.APPROVED, STATUS.VERIFIED, STATUS.CPA].indexOf(r.status) >= 0; })
          .map(function (r) { return { id: r.id, match: matchPunches(punches[r.empId] || [], r, s.graceMinutes) }; });
        var emps = employees().filter(function (e) { return isTrue(e.active) && e.timeClockName; });
        var cands = [], unap = [];
        months.forEach(function (m) {
          cands = cands.concat(clockCandidates(punches, emps, hol, s, m));
          unap = unap.concat(unapprovedExtra(punches, emps, reqs, hol, s, m));
        });
        return {
          from: from, to: to,
          rows: rows,
          unapproved: unap.filter(function (x) { return inR(x.date); }),
          candidates: cands.filter(function (c) { return inR(c.date); }).map(function (c) {
            c.records = reqs.filter(function (r) { return r.empId === c.empId && r.date === c.date && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0; })
              .map(function (r) { return r.id; });
            return c;
          }).sort(function (a, b) { return (a.empId + a.date).localeCompare(b.empId + b.date); }),
          punchCount: Object.keys(punches).reduce(function (a, k) { return a + punches[k].filter(function (x) { return inR(x.date); }).length; }, 0)
        };
      },

      verify: function (p) {
        var u = auth(p);
        need(u, 'admin');
        var items = p.items || [];
        return store.lock(function () {
          var all = store.read('Requests'), emps = employees(), now = store.nowET(), done = [];
          items.forEach(function (it) {
            var r = all.filter(function (x) { return x.id === it.id; })[0];
            if (!r) err('NOTFOUND', it.id);
            if ([STATUS.APPROVED, STATUS.VERIFIED].indexOf(r.status) < 0) err('STATE', r.id + ': ' + r.status);
            if ((r.date + 'T' + r.end) > now.slice(0, 16) && windowOf(r).e < 1440) err('FUTURE', 'FUTURE:' + r.id);
            var rec = round2(it.recognizedHours);
            if (rec < 0 || rec > 24) err('CAP', 'CAP:' + r.id);
            if (it.result === 'MANUAL' && !String(it.note || '').trim()) err('NOTE', 'NOTE:' + r.id);
            var emp = emps.filter(function (e) { return e.id === r.empId; })[0] || {};
            r.actualIn = it.actualIn || ''; r.actualOut = it.actualOut || '';
            r.actualHours = String(it.actualHours == null ? '' : it.actualHours);
            r.verifyResult = it.result || 'MANUAL';
            r.recognizedHours = String(rec);
            r.rate = String(Number(emp.rate) || 0);
            r.pay = String(round2(rec * (Number(emp.rate) || 0) * (Number(r.multiplier) || 1)));
            r.verifyNote = String(it.note || '');
            r.verifiedAt = now; r.verifiedBy = u.nameEn || u.name;
            r.status = STATUS.VERIFIED;
            store.upsert('Requests', 'id', r);
            done.push(r);
          });
          log(u, 'verify', '', done.map(function (r) { return r.id + ':' + r.recognizedHours; }).join(','));
          return { requests: done };
        });
      },

      /** Admin final approval straight from Time Clock candidates. */
      finalizeClock: function (p) {
        var u = auth(p); need(u, 'admin');
        var items = p.items || [];
        var s = settings(), hol = holidays();
        // Re-derive candidates from the Time Clock on the server: only what is in the Time Clock can be approved.
        var cand = {};
        var months = {};
        items.forEach(function (it) { months[String(it.date).slice(0, 7)] = 1; });
        Object.keys(months).forEach(function (m) {
          var from = m + '-01', to = addDays(addDays(m + '-28', 4).slice(0, 7) + '-01', -1);
          var emps0 = employees().filter(function (e) { return isTrue(e.active) && e.timeClockName; });
          clockCandidates(punchesFor(from, to), emps0, hol, s, m).forEach(function (c) { cand[c.key] = c; });
        });
        return store.lock(function () {
          var all = store.read('Requests'), emps = employees(), now = store.nowET(), done = [];
          var seq = all.length;
          items.forEach(function (it) {
            var emp = emps.filter(function (e) { return e.id === it.empId; })[0];
            if (!emp) err('NOTFOUND', it.empId);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) err('DATE', 'Invalid date');
            var dup = all.concat(done).filter(function (r) { return r.empId === it.empId && r.date === it.date && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0; });
            var claim = dup.filter(function (r) { return r.status === STATUS.PENDING && r.source === 'CLOCK'; })[0];
            if (dup.length && !(claim && dup.length === 1)) err('DUP', 'DUP:' + emp.name + ' ' + it.date);
            var c = cand[it.empId + '|' + it.date];
            if (!c || !(c.otHours > 0)) err('NOCLOCK', 'NOCLOCK:' + emp.name + ' ' + it.date);
            it.otStart = c.otStart; it.otEnd = c.otEnd; it.clockHours = c.otHours;
            var ps = String(c.punches || '').split(', ');
            it.actualIn = (ps[0] || '').split('–')[0]; it.actualOut = (ps[ps.length - 1] || '').split('–')[1] || '';
            var pre = !!it.preConfirmed;
            if (!pre && !String(it.note || '').trim()) err('EXCEPTION', 'EXCEPTION:' + emp.name + ' ' + it.date);
            var rec = round2(it.recognizedHours);
            if (!(rec > 0)) err('HOURS', 'HOURS:' + emp.name + ' ' + it.date);
            if (rec > c.otHours) err('OVERCLOCK', 'OVERCLOCK:' + emp.name + ' ' + it.date + ' (max ' + c.otHours + 'h)');
            var mult = multiplierFor(it.date, hol, s), rate = Number(emp.rate) || 0;
            seq++;
            var r = {
              id: 'OT' + it.date.slice(2, 4) + it.date.slice(5, 7) + '-' + ('000' + seq).slice(-4) + '-' + store.uuid().slice(0, 4).toUpperCase(),
              groupId: 'CLOCK', empId: emp.id, empName: emp.name, date: it.date,
              start: it.otStart || '', end: it.otEnd || '', breakMin: String(Number(it.breakMin) || 0),
              otType: String(it.otType || ''), description: String(it.task || ''),
              hours: String(round2(it.clockHours)), premium: isPremiumDay(it.date, hol, s) ? 'Y' : 'N', multiplier: String(mult),
              status: STATUS.VERIFIED, ack: '', submittedAt: now,
              decidedAt: now, decidedBy: u.id, decidedByName: u.nameEn || u.name,
              decisionComment: pre ? 'Pre-confirmed by manager' : 'Exception (no pre-approval)',
              actualIn: it.actualIn || '', actualOut: it.actualOut || '', actualHours: String(round2(it.clockHours)),
              verifyResult: rec === round2(Number(it.clockHours) - (Number(it.breakMin) || 0) / 60) ? 'CLOCK' : 'MANUAL',
              recognizedHours: String(rec), rate: String(rate), pay: String(round2(rec * rate * mult)),
              verifyNote: String(it.note || ''), verifiedAt: now, verifiedBy: u.nameEn || u.name, docId: '',
              lateEntry: 'N', lateReason: pre ? '' : String(it.note || ''), preApproved: pre ? 'Y' : 'N', source: 'CLOCK'
            };
            if (claim) {
              r.id = claim.id; r.submittedAt = claim.submittedAt; r.preMethod = claim.preMethod || ''; r.preBy = claim.preBy || '';
              if (!r.description) r.description = claim.description || '';
              r._update = true;
            }
            done.push(r);
          });
          done.forEach(function (r) { var up = r._update; delete r._update; if (up) store.upsert('Requests', 'id', r); else store.append('Requests', r); });
          log(u, 'finalizeClock', '', done.map(function (r) { return r.id + ':' + r.recognizedHours + (r.preApproved === 'N' ? '(exception)' : ''); }).join(','));
          done.forEach(function (r) {
            try {
              var emp = emps.filter(function (e) { return e.id === r.empId; })[0];
              if (!emp || !emp.email) return;
              store.sendMail(emp.email, '[JNFAM OT] 최종 승인 / Final approved — ' + r.date,
                '<div style="font-family:Arial,sans-serif;font-size:14px"><p>OT가 최종 승인되었습니다. / Your overtime has been final-approved.</p>'
                + '<p>' + r.date + ' · ' + r.start + '–' + r.end + ' · ' + r.recognizedHours + 'h' + (r.preApproved === 'N' ? ' · ⚠ 사후 / Post' : '') + '</p>'
                + (r.verifyNote ? '<p>Note: ' + esc(r.verifyNote) + '</p>' : '') + '<p>' + esc(u.nameEn || u.name) + ' · ' + now + ' ET</p></div>', '');
            } catch (e) { }
          });
          return { requests: done };
        });
      },

      /** Employee claims an overtime day straight from their own Time Clock record. */
      claimClock: function (p) {
        var u = auth(p);
        var s = settings(), hol = holidays();
        var date = String(p.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) err('DATE', 'Invalid date');
        if (!u.timeClockName) err('NOTLINKED', 'Not linked to Time Clock');
        if (!String(p.task || '').trim()) err('TASK', 'Task description required');
        var method = { verbal: 1, email: 1, none: 1 }[p.preMethod] ? p.preMethod : '';
        if (!method) err('PREMETHOD', 'Select how overtime was pre-approved');
        if (method === 'none' && !String(p.note || '').trim()) err('EXCEPTION', 'EXCEPTION:' + date);
        var m = date.slice(0, 7);
        var from = m + '-01', to = addDays(addDays(m + '-28', 4).slice(0, 7) + '-01', -1);
        var mine = {}; mine[u.id] = punchesFor(from, to)[u.id] || [];
        var c = clockCandidates(mine, [u], hol, s, m).filter(function (x) { return x.date === date; })[0];
        if (!c || !(c.otHours > 0)) err('NOCLOCK', 'NOCLOCK:' + date);
        return store.lock(function () {
          var all = store.read('Requests'), now = store.nowET();
          var dup = all.filter(function (r) { return r.empId === u.id && r.date === date && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0; });
          if (dup.length) err('DUP', 'DUP:' + date + ' (' + dup[0].status + ')');
          var ps = String(c.punches || '').split(', ');
          var r = {
            id: 'OT' + date.slice(2, 4) + date.slice(5, 7) + '-' + ('000' + (all.length + 1)).slice(-4) + '-' + store.uuid().slice(0, 4).toUpperCase(),
            groupId: 'CLOCK', empId: u.id, empName: u.name, date: date, start: c.otStart, end: c.otEnd, breakMin: '0',
            otType: '', description: String(p.task).trim(), hours: String(c.otHours),
            premium: isPremiumDay(date, hol, s) ? 'Y' : 'N', multiplier: String(multiplierFor(date, hol, s)),
            status: STATUS.PENDING, ack: 'TRUE', submittedAt: now,
            actualIn: (ps[0] || '').split('–')[0], actualOut: (ps[ps.length - 1] || '').split('–')[1] || '', actualHours: String(c.otHours),
            lateEntry: 'N', lateReason: method === 'none' ? String(p.note).trim() : '', verifyNote: String(p.note || '').trim(),
            source: 'CLOCK', preMethod: method, preBy: String(p.preBy || '').trim()
          };
          store.append('Requests', r);
          log(u, 'claimClock', r.id, date + ' ' + c.otHours + 'h ' + method);
          try {
            var to2 = employees().filter(function (e) { return isTrue(e.active) && (has(e, 'admin') || has(e, 'approver')) && e.email && e.id !== u.id; }).map(function (e) { return e.email; });
            if (s.adminEmail) to2.push(s.adminEmail);
            to2 = to2.filter(function (v, i, a) { return a.indexOf(v) === i; });
            if (to2.length) store.sendMail(to2.join(','), '[JNFAM OT] OT 신청 / Overtime claim — ' + (u.nameEn || u.name) + ' ' + date,
              '<div style="font-family:Arial,sans-serif;font-size:14px"><p><b>' + esc(u.name) + '</b> 님이 OT를 신청했습니다. / ' + esc(u.nameEn || u.name) + ' submitted an overtime claim.</p>'
              + '<p>' + date + ' · Time Clock ' + esc(c.punches) + ' · OT ' + esc(c.otLabel) + ' (' + c.otHours + 'h)</p>'
              + '<p>작업 / Task: ' + esc(r.description) + '<br>사전 승인 / Pre-approval: ' + ({ verbal: '구두 / Verbal', email: '메일 / Email', none: '없음 / None' })[method] + (r.preBy ? ' (' + esc(r.preBy) + ')' : '') + (r.verifyNote ? '<br>비고 / Note: ' + esc(r.verifyNote) : '') + '</p>'
              + (s.appUrl ? '<p><a href="' + s.appUrl + '">' + s.appUrl + '</a></p>' : '') + '</div>', s.ccEmail);
          } catch (e) { log(u, 'mail-error', r.id, String(e)); }
          return { request: r };
        });
      },

      rejectClaim: function (p) {
        var u = auth(p); need(u, 'admin');
        var items = p.items || [];
        return store.lock(function () {
          var all = store.read('Requests'), now = store.nowET(), done = [];
          items.forEach(function (it) {
            var r = all.filter(function (x) { return x.id === it.id; })[0];
            if (!r || r.status !== STATUS.PENDING) err('STATE', 'STATE:' + it.id);
            if (!String(it.note || '').trim()) err('COMMENT', 'Reason required');
            r.status = STATUS.REJECTED; r.decidedAt = now; r.decidedBy = u.id; r.decidedByName = u.nameEn || u.name; r.decisionComment = String(it.note).trim();
            store.upsert('Requests', 'id', r); done.push(r);
            try { mailApplicant(r, u, settings()); } catch (e) { }
          });
          log(u, 'rejectClaim', '', done.map(function (r) { return r.id; }).join(','));
          return { requests: done };
        });
      },

      /** Mark a Time Clock day as already handled / not OT so it never shows up again. */
      excludeClock: function (p) {
        var u = auth(p); need(u, 'admin');
        var items = p.items || [];
        return store.lock(function () {
          var all = store.read('Requests'), emps = employees(), now = store.nowET(), done = [];
          var seq = all.length;
          items.forEach(function (it) {
            var emp = emps.filter(function (e) { return e.id === it.empId; })[0];
            if (!emp) err('NOTFOUND', it.empId);
            if (!String(it.note || '').trim()) err('EXCLUDE_NOTE', 'EXCLUDE_NOTE:' + emp.name + ' ' + it.date);
            var dup = all.concat(done).filter(function (r) { return r.empId === it.empId && r.date === it.date && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0; });
            if (dup.length) err('DUP', 'DUP:' + emp.name + ' ' + it.date);
            seq++;
            done.push({
              id: 'OT' + it.date.slice(2, 4) + it.date.slice(5, 7) + '-' + ('000' + seq).slice(-4) + '-' + store.uuid().slice(0, 4).toUpperCase(),
              groupId: 'CLOCK', empId: emp.id, empName: emp.name, date: it.date, start: it.otStart || '', end: it.otEnd || '', breakMin: '0',
              otType: '', description: '', hours: String(round2(it.clockHours)), premium: '', multiplier: '',
              status: STATUS.EXCLUDED, submittedAt: now, decidedAt: now, decidedBy: u.id, decidedByName: u.nameEn || u.name,
              decisionComment: 'Excluded: ' + String(it.note).trim(), verifyNote: String(it.note).trim(), recognizedHours: '0', pay: '0',
              source: 'CLOCK', preApproved: ''
            });
          });
          done.forEach(function (r) { store.append('Requests', r); });
          log(u, 'excludeClock', '', done.map(function (r) { return r.empId + '|' + r.date; }).join(','));
          return { requests: done };
        });
      },

      unverify: function (p) {
        var u = auth(p); need(u, 'admin');
        return store.lock(function () {
          var r = store.read('Requests').filter(function (x) { return x.id === p.id; })[0];
          if (!r || (r.status !== STATUS.VERIFIED && r.status !== STATUS.EXCLUDED)) err('STATE');
          if (r.source === 'CLOCK') {
            r.status = STATUS.CANCELLED; r.decisionComment = (r.decisionComment || '') + ' / Undone ' + store.nowET();
            store.upsert('Requests', 'id', r); log(u, 'unverify', r.id); return { request: r };
          }
          ['actualIn', 'actualOut', 'actualHours', 'verifyResult', 'recognizedHours', 'rate', 'pay', 'verifyNote', 'verifiedAt', 'verifiedBy'].forEach(function (k) { r[k] = ''; });
          r.status = STATUS.APPROVED;
          store.upsert('Requests', 'id', r);
          log(u, 'unverify', r.id);
          return { request: r };
        });
      },

      issueDoc: function (p) {
        var u = auth(p); need(u, 'admin');
        return store.lock(function () {
          var all = store.read('Requests'), now = store.nowET();
          var sel = all.filter(function (r) { return (p.ids || []).indexOf(r.id) >= 0; });
          if (!sel.length) err('EMPTY', 'Nothing selected');
          var pf = p.from || (p.month ? p.month + '-01' : ''), pt = p.to || (p.month ? addDays(addDays(p.month + '-28', 4).slice(0, 7) + '-01', -1) : '');
          var seen = {};
          sel.forEach(function (r) {
            if (r.status !== STATUS.VERIFIED) err('STATE', r.id + ' is not verified');
            if (r.date < pf || r.date > pt) err('MONTH', 'Out of period: ' + r.id);
            var k = r.empId + '|' + r.date;
            if (seen[k]) err('DUPDOC', 'DUPDOC:' + r.empName + ' ' + r.date);
            seen[k] = 1;
            var prev = all.filter(function (x) { return x.id !== r.id && x.empId === r.empId && x.date === r.date && x.status === STATUS.CPA; })[0];
            if (prev) err('DUPDOC', 'DUPDOC:' + r.empName + ' ' + r.date + ' → ' + prev.docId);
          });
          var docs = store.read('Docs');
          var prefix = 'OT-' + now.slice(0, 10).replace(/-/g, '') + '-';
          var n = docs.filter(function (d) { return String(d.id).indexOf(prefix) === 0; }).length + 1;
          var doc = {
            id: prefix + ('0' + n).slice(-2), month: pt.slice(0, 7), periodFrom: pf, periodTo: pt, createdAt: now, createdBy: u.nameEn || u.name,
            requestIds: sel.map(function (r) { return r.id; }).join(','),
            totalHours: String(round2(sel.reduce(function (a, r) { return a + Number(r.recognizedHours || 0); }, 0))),
            totalPay: String(round2(sel.reduce(function (a, r) { return a + Number(r.pay || 0); }, 0))),
            status: 'ISSUED', note: String(p.note || '')
          };
          store.append('Docs', doc);
          sel.forEach(function (r) { r.status = STATUS.CPA; r.docId = doc.id; store.upsert('Requests', 'id', r); });
          log(u, 'issueDoc', doc.id, doc.requestIds);
          return { doc: doc };
        });
      },

      voidDoc: function (p) {
        var u = auth(p); need(u, 'admin');
        return store.lock(function () {
          var d = store.read('Docs').filter(function (x) { return x.id === p.id; })[0];
          if (!d || d.status === 'VOID') err('STATE');
          d.status = 'VOID'; d.note = (d.note ? d.note + ' / ' : '') + 'Voided ' + store.nowET() + ' by ' + (u.nameEn || u.name);
          store.upsert('Docs', 'id', d);
          store.read('Requests').forEach(function (r) { if (r.docId === d.id) { r.status = STATUS.VERIFIED; r.docId = ''; store.upsert('Requests', 'id', r); } });
          log(u, 'voidDoc', d.id);
          return { doc: d };
        });
      },

      saveEmployee: function (p) {
        var u = auth(p); need(u, 'admin');
        var e = p.emp || {};
        return store.lock(function () {
          var list = employees();
          var cur = e.id ? list.filter(function (x) { return x.id === e.id; })[0] : null;
          if (!cur) {
            if (!e.id) { var max = 0; list.forEach(function (x) { var m = /^E(\d+)$/.exec(x.id); if (m) max = Math.max(max, Number(m[1])); }); e.id = 'E' + ('00' + (max + 1)).slice(-3); }
            cur = { id: e.id, pin: '0000', active: 'TRUE' };
          }
          ['name', 'nameEn', 'timeClockName', 'email', 'dept', 'rate', 'roles', 'active', 'schedStart', 'schedEnd'].forEach(function (k) { if (e[k] !== undefined) cur[k] = String(e[k]); });
          if (e.pin) cur.pin = String(e.pin);
          if (cur.id === u.id && !has(cur, 'admin')) err('SELFADMIN', 'You cannot remove your own admin role');
          store.upsert('Employees', 'id', cur);
          log(u, 'saveEmployee', cur.id);
          return { emp: publicEmp(cur, true) };
        });
      },

      saveSettings: function (p) {
        var u = auth(p); need(u, 'admin');
        var s = settings();
        Object.keys(p.settings || {}).forEach(function (k) { if (k in DEFAULT_SETTINGS) s[k] = String(p.settings[k]); });
        store.replaceAll('Settings', Object.keys(s).map(function (k) { return { key: k, value: s[k] }; }));
        log(u, 'saveSettings');
        return { settings: s };
      },

      saveHolidays: function (p) {
        var u = auth(p); need(u, 'admin');
        var list = (p.holidays || []).filter(function (h) { return /^\d{4}-\d{2}-\d{2}$/.test(h.date); })
          .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        store.replaceAll('Holidays', list);
        log(u, 'saveHolidays', '', String(list.length));
        return { holidays: list };
      },

      changePin: function (p) {
        var u = auth(p);
        if (String(u.pin) !== String(p.oldPin)) err('PIN', 'Current PIN is incorrect');
        if (!/^\d{4,8}$/.test(String(p.newPin))) err('PIN', 'PIN must be 4–8 digits');
        u.pin = String(p.newPin);
        store.upsert('Employees', 'id', u);
        log(u, 'changePin');
        return { ok: true };
      },

      /** Employee: own Time Clock days with overtime + processing status (own data only). */
      myClock: function (p) {
        var u = auth(p);
        var from, to;
        if (p.from && p.to) { from = String(p.from); to = String(p.to); }
        else {
          var month = String(p.month || '').slice(0, 7);
          if (!/^\d{4}-\d{2}$/.test(month)) err('MONTH', 'Invalid month');
          from = month + '-01'; to = addDays(addDays(month + '-28', 4).slice(0, 7) + '-01', -1);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) err('PERIOD', 'Invalid period');
        if (addDays(from, 186) < to) err('PERIOD', 'Period too long (max 6 months)');
        if (!u.timeClockName) return { days: [], linked: false };
        var s = settings(), hol = holidays();
        var months = [];
        for (var mm = from.slice(0, 7); mm <= to.slice(0, 7); mm = addDays(mm + '-28', 4).slice(0, 7)) months.push(mm);
        var all = punchesFor(from, to);
        var mine = {}; mine[u.id] = all[u.id] || [];
        var reqs = store.read('Requests').filter(function (r) { return r.empId === u.id && r.date >= from && r.date <= to && [STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED].indexOf(r.status) < 0; });
        var cc = [];
        months.forEach(function (m) { cc = cc.concat(clockCandidates(mine, [u], hol, s, m)); });
        var days = cc.filter(function (c) { return c.date >= from && c.date <= to; }).map(function (c) {
          var rs = reqs.filter(function (r) { return r.date === c.date; });
          var rj = store.read('Requests').filter(function (r) { return r.empId === u.id && r.date === c.date && r.status === STATUS.REJECTED; }).pop();
          return { id: rs.length ? rs[0].id : '', rejectNote: !rs.length && rj ? rj.decisionComment : '', description: rs.length ? rs[0].description : '', date: c.date, offDay: c.offDay, sched: c.sched, punches: c.punches, anomalies: c.anomalies, otLabel: c.otLabel, otHours: c.otHours,
            status: rs.length ? rs[0].status : '', recognizedHours: rs.length ? rs[0].recognizedHours : '', preApproved: rs.length ? rs[0].preApproved : '', docId: rs.length ? rs[0].docId : '' };
        });
        return { days: days, linked: true, startDate: s.startDate || '' };
      },

      timelog: function (p) {
        var u = auth(p); need(u, 'admin');
        var by = punchesFor(p.from, p.to);
        return { punches: by };
      }
    };

    function handle(action, payload) {
      try {
        if (!handlers[action]) err('ACTION', 'Unknown action: ' + action);
        return { ok: true, data: handlers[action](payload || {}) };
      } catch (e) {
        return { ok: false, code: e.code || 'ERROR', error: String(e.message || e) };
      }
    }
    return { handle: handle };
  }

  /** 'Y' approved before start · 'N' approved after start · '' not decided */
  function preApprovedOf(r) {
    if (r.preApproved === 'Y' || r.preApproved === 'N') return r.preApproved;
    if (!r.decidedAt || !r.date || !r.start) return '';
    return String(r.decidedAt).slice(0, 16) < (r.date + 'T' + r.start) ? 'Y' : 'N';
  }

  return {
    VERSION: VERSION, preApprovedOf: preApprovedOf, STATUS: STATUS, COLUMNS: COLUMNS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    create: create, calcHours: calcHours, toMin: toMin, addDays: addDays, weekday: weekday, pad: pad,
    isPremiumDay: isPremiumDay, multiplierFor: multiplierFor, federalHolidays: federalHolidays,
    matchPunches: matchPunches, unapprovedExtra: unapprovedExtra, clockCandidates: clockCandidates, round2: round2, windowOf: windowOf, isTrue: isTrue
  };
})();



var TZ = 'America/New_York';
var _memo = {};

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('DATA_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  var cols = OTCore.COLUMNS[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#eef2f0');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  } else {
    var lastCol = Math.max(1, sh.getLastColumn());
    var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var missing = cols.filter(function (c) { return head.indexOf(c) < 0; });
    if (missing.length) {
      sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#eef2f0');
      sh.getRange(1, lastCol + 1, sh.getMaxRows(), missing.length).setNumberFormat('@');
    }
  }
  return sh;
}

function table_(name) {
  if (_memo[name]) return _memo[name];
  var sh = sheet_(name);
  var vals = sh.getDataRange().getDisplayValues();
  var head = vals[0];
  var rows = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {}, any = false;
    for (var j = 0; j < head.length; j++) { if (head[j]) { o[head[j]] = vals[i][j]; if (vals[i][j] !== '') any = true; } }
    if (any) { o.__row = i + 1; rows.push(o); }
  }
  _memo[name] = { sh: sh, head: head, rows: rows };
  return _memo[name];
}

function rowValues_(head, obj) {
  return head.map(function (h) { var v = obj[h]; return v == null ? '' : String(v); });
}

function clean_(o) { var c = {}; for (var k in o) if (k !== '__row') c[k] = o[k]; return c; }

var SheetStore = {
  read: function (name) { return table_(name).rows.map(clean_); },
  append: function (name, row) {
    var t = table_(name);
    var r = t.sh.getLastRow() + 1;
    t.sh.getRange(r, 1, 1, t.head.length).setNumberFormat('@').setValues([rowValues_(t.head, row)]);
    var c = clean_(row); c.__row = r; t.rows.push(c);
  },
  upsert: function (name, key, row) {
    var t = table_(name);
    for (var i = 0; i < t.rows.length; i++) {
      if (t.rows[i][key] === row[key]) {
        var r = t.rows[i].__row;
        var merged = clean_(t.rows[i]); for (var k in row) merged[k] = row[k];
        t.sh.getRange(r, 1, 1, t.head.length).setNumberFormat('@').setValues([rowValues_(t.head, merged)]);
        merged.__row = r; t.rows[i] = merged;
        return;
      }
    }
    SheetStore.append(name, row);
  },
  replaceAll: function (name, rows) {
    var t = table_(name);
    var last = t.sh.getLastRow();
    if (last > 1) t.sh.getRange(2, 1, last - 1, t.sh.getLastColumn()).clearContent();
    if (rows.length) t.sh.getRange(2, 1, rows.length, t.head.length).setNumberFormat('@').setValues(rows.map(function (r) { return rowValues_(t.head, r); }));
    delete _memo[name];
  },
  sessionSet: function (token, id) { CacheService.getScriptCache().put('s_' + token, id, 21600); },
  sessionGet: function (token) {
    var c = CacheService.getScriptCache(), v = c.get('s_' + token);
    if (v) c.put('s_' + token, v, 21600);
    return v;
  },
  uuid: function () { return Utilities.getUuid(); },
  nowET: function () { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); },
  lock: function (fn) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { _memo = {}; return fn(); } finally { lock.releaseLock(); }
  },
  sendMail: function (to, subject, html, cc) {
    if (!to) return;
    var o = { to: to, subject: subject, htmlBody: html, name: 'JNFAM OT' };
    if (cc) o.cc = cc;
    MailApp.sendEmail(o);
  },
  /** Reads the Time Clock "TimeLog" sheet → [{date,time,name,type}] (ET wall clock). */
  timelog: function (from, to) {
    var s = {};
    SheetStore.read('Settings').forEach(function (r) { s[r.key] = r.value; });
    var id = s.timeClockSheetId || OTCore.DEFAULT_SETTINGS.timeClockSheetId;
    var tab = s.timeClockSheetName || OTCore.DEFAULT_SETTINGS.timeClockSheetName;
    var sh = SpreadsheetApp.openById(id).getSheetByName(tab);
    if (!sh) throw new Error('Time Clock tab not found: ' + tab);
    var vals = sh.getDataRange().getDisplayValues();
    var h = vals[0].map(String);
    function col(re) { for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; }
    var cIso = col(/ISO/i), cDate = col(/\(Date\)|날짜/), cName = col(/\(Name\)|이름/), cType = col(/\(Type\)|구분/), cTime = col(/\(Time\)|시각/);
    if (cName < 0 || cType < 0) throw new Error('Time Clock header not recognised');
    var out = [];
    for (var i = 1; i < vals.length; i++) {
      var v = vals[i], date = '', time = '';
      var iso = cIso >= 0 ? String(v[cIso]) : '';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) { date = iso.slice(0, 10); time = iso.slice(11, 19); }
      else {
        date = normDate_(v[cDate]); time = String(v[cTime] || '');
      }
      if (!date || date < from || date > to) continue;
      out.push({ date: date, time: time, name: String(v[cName]).trim(), type: String(v[cType]).trim().toUpperCase() });
    }
    return out;
  }
};

function normDate_(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  return '';
}

var _api = null;
function api_() { return _api || (_api = OTCore.create(SheetStore)); }

function doPost(e) {
  var res;
  try {
    var body = JSON.parse(e.postData.contents);
    _memo = {};
    res = api_().handle(body.action, body.payload || {});
  } catch (err) {
    res = { ok: false, code: 'BAD_REQUEST', error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'JNFAM OT', version: OTCore.VERSION, nowET: SheetStore.nowET() }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor: creates sheets, seeds employees/settings. */
function setup() {
  Object.keys(OTCore.COLUMNS).forEach(function (n) { sheet_(n); });
  _memo = {};
  api_().handle('loginList', {});
  if (!SheetStore.read('Settings').length) {
    var d = OTCore.DEFAULT_SETTINGS;
    SheetStore.replaceAll('Settings', Object.keys(d).map(function (k) { return { key: k, value: d[k] }; }));
  }
  var def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('시트1');
  if (def && ss_().getSheets().length > 1 && def.getLastRow() === 0) ss_().deleteSheet(def);
  Logger.log('Setup complete. Default admin: admin / 1234 — change it after first login.');
}

/** Run from the editor to authorise and test Time Clock access. */
function testTimeClock() {
  var now = SheetStore.nowET().slice(0, 10);
  var from = OTCore.addDays(now, -31);
  var rows = SheetStore.timelog(from, now);
  Logger.log('Time Clock punches in last 31 days: ' + rows.length);
  Logger.log(JSON.stringify(rows.slice(-5)));
}
