/**
 * PEDIDO DIARIO DE HILO A MATERIA PRIMA - Swantex
 * ------------------------------------------------------------
 * Todos los dias a las 8:00 a.m. (hora Bogota) envia un correo con el hilo que
 * se necesita segun las maquinas MONTADAS en este momento: item, titulo, lote y kilos.
 *
 * Usa el mismo calculo del modulo "Hilos y Materia Prima":
 *   tubos proyectados = (60 / tiempo por tubo en min) * horas * (eficiencia / 100)
 *   gramos de la referencia = tubos proyectados * peso del tubo (g)
 *   gramos de cada hilo = gramos de la referencia * (% del hilo en la ficha)
 * y los suma por (tipo de fibra + titulo + lote) entre todas las maquinas.
 *
 * Los datos se leen directo de Firebase (proyecto swantex-produccion):
 *   - lotes ABIERTOS  -> que referencia tiene montada cada maquina
 *   - fichas de precosteo (ids SW-... y STRUCT-...) -> peso, tiempo e hilos
 *
 * INSTALACION (una sola vez): ver instrucciones al final de este archivo.
 */

// ===================== CONFIGURACION (edite aqui) =====================
var DESTINATARIOS = '';                       // Ej: 'materiaprima@swantex.com, otra@gmail.com' (varios separados por coma)
var COPIA = 'jdposada33@gmail.com';           // copia para usted (deje '' para no copiar)
var HORAS_PROYECCION = 24;                     // 0 = lo que falta del dia hasta medianoche (igual que Hilos); o un numero fijo, ej: 24
var EFICIENCIA_PCT = 85;                      // eficiencia esperada (igual que Hilos)
var HORA_ENVIO = 8;                           // hora del envio diario (0-23, hora Bogota)
var ZONA = 'America/Bogota';
var PROYECTO = 'swantex-produccion';
var API_KEY = 'AIzaSyAZkeIEa2xhXeyV6Ndy18FFJ3a6msCEyWQ';   // clave web publica de Firebase (no es secreta)
// ======================================================================

/** Envia el pedido a los destinatarios (es lo que ejecuta el disparador diario). */
function enviarPedidoHilos() {
  try {
    var r = construirPedido_();
    var para = (DESTINATARIOS || '').trim() || Session.getEffectiveUser().getEmail();
    var opts = { to: para, subject: r.asunto, htmlBody: r.html, body: r.texto, name: 'Swantex - Pedido de hilo' };
    if (COPIA && para.indexOf(COPIA) < 0) opts.cc = COPIA;
    MailApp.sendEmail(opts);
    Logger.log('Pedido enviado a ' + para + ' (' + r.nMaquinas + ' maquinas, ' + r.totalKg.toFixed(2) + ' kg)');
  } catch (e) {
    // Si algo falla, avisa al dueno del script en vez de fallar en silencio
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'FALLO el pedido automatico de hilo',
      'No se pudo generar el pedido de hilo de hoy.\n\nError: ' + e.message + '\n\nRevise Firebase y el script (Apps Script > Ejecuciones).');
    throw e;
  }
}

/** PRUEBA: envia el pedido SOLO a su correo (no a materia prima). Ejecutela primero. */
function enviarPedidoPrueba() {
  var r = construirPedido_();
  var yo = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: yo, subject: '[PRUEBA] ' + r.asunto, htmlBody: r.html, body: r.texto, name: 'Swantex - Pedido de hilo' });
  Logger.log('Prueba enviada a ' + yo);
}

/** Crea el disparador diario (ejecutela UNA vez). Borra los anteriores de esta funcion para no duplicar. */
function instalarDisparador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarPedidoHilos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('enviarPedidoHilos').timeBased().everyDays(1).atHour(HORA_ENVIO).inTimezone(ZONA).create();
  Logger.log('Listo: se enviara todos los dias a las ' + HORA_ENVIO + ':00 (' + ZONA + ')');
}

// ----------------------------------------------------------------------
// Calculo del pedido
// ----------------------------------------------------------------------
function construirPedido_() {
  var ahora = new Date();
  var horas = HORAS_PROYECCION > 0 ? HORAS_PROYECCION : horasHastaMedianoche_(ahora);
  var eff = EFICIENCIA_PCT > 0 ? EFICIENCIA_PCT : 85;

  var lotes = consultarLotesAbiertos_();
  var mats = cargarMateriales_();

  var porHilo = {};          // nombre|titulo|lote -> {...gramos}
  var maquinas = [];         // detalle por maquina
  var sinFicha = [], sinTiempo = [];

  lotes.sort(function (a, b) { return naturalCmp_(a.maqId, b.maqId); });
  lotes.forEach(function (l) {
    var code = String(l.refId || '').trim().toUpperCase();
    var mat = mats[code];
    if (!mat) { sinFicha.push(l.maqId + ' (' + (code || 'sin ref') + ')'); return; }
    if (!mat.tiempoPorTuboMin) { sinTiempo.push(l.maqId + ' (' + code + ')'); return; }
    var tubosProy = (60 / mat.tiempoPorTuboMin) * horas * (eff / 100);
    var gramosTotal = tubosProy * mat.pesoTuboG;
    mat.fibras.forEach(function (f) {
      var key = f.nombre + '|' + f.titulo + '|' + f.lote;
      if (!porHilo[key]) porHilo[key] = { nombre: f.nombre, titulo: f.titulo, lote: f.lote, itemsS: [], itemsZ: [], gramos: 0, maqs: {} };
      if (f.itemS && porHilo[key].itemsS.indexOf(f.itemS) < 0) porHilo[key].itemsS.push(f.itemS);
      if (f.itemZ && porHilo[key].itemsZ.indexOf(f.itemZ) < 0) porHilo[key].itemsZ.push(f.itemZ);
      porHilo[key].gramos += gramosTotal * (f.porcentaje / 100);
      porHilo[key].maqs[l.maqId] = 1;
    });
    maquinas.push({ maq: l.maqId, ref: code, nombre: mat.nombre, tubos: Math.round(tubosProy), parada: !!l.parado });
  });

  var filas = Object.keys(porHilo).map(function (k) { return porHilo[k]; })
    .filter(function (r) { return r.gramos / 1000 >= 0.005; })
    .sort(function (a, b) { return b.gramos - a.gramos; });
  var totalKg = filas.reduce(function (s, r) { return s + r.gramos / 1000; }, 0);

  var fecha = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
  var hora = Utilities.formatDate(ahora, ZONA, 'HH:mm');
  var info = {
    fecha: fecha, hora: hora, horas: horas, eff: eff, filas: filas, totalKg: totalKg, maquinas: maquinas,
    nLotes: lotes.length, sinFicha: sinFicha, sinTiempo: sinTiempo
  };
  return {
    asunto: '📦 Pedido de hilo – Planta Swantex [' + fecha + ']',
    html: htmlPedido_(info), texto: textoPedido_(info), nMaquinas: maquinas.length, totalKg: totalKg
  };
}

function horasHastaMedianoche_(d) {
  var h = parseInt(Utilities.formatDate(d, ZONA, 'H'), 10), m = parseInt(Utilities.formatDate(d, ZONA, 'm'), 10);
  var rest = 24 - (h + m / 60);
  return Math.max(1, Math.round(rest * 2) / 2);
}

function naturalCmp_(a, b) {
  var pa = String(a).match(/^([A-Za-z]*)(\d*)/), pb = String(b).match(/^([A-Za-z]*)(\d*)/);
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return (parseInt(pa[2] || 0, 10)) - (parseInt(pb[2] || 0, 10));
}

// ----------------------------------------------------------------------
// Lectura de Firebase (REST)
// ----------------------------------------------------------------------
function runQuery_(structuredQuery) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + PROYECTO + '/databases/(default)/documents:runQuery?key=' + API_KEY;
  var resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ structuredQuery: structuredQuery })
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('Firebase respondio ' + code + ': ' + String(resp.getContentText()).slice(0, 300));
  var out = [];
  JSON.parse(resp.getContentText()).forEach(function (r) { if (r.document) out.push(r.document); });
  return out;
}

function consultarLotesAbiertos_() {
  var docs = runQuery_({
    from: [{ collectionId: 'fichas' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'tipo' }, op: 'EQUAL', value: { stringValue: 'lote' } } },
      { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'abierto' } } }
    ] } }
  });
  var out = [];
  docs.forEach(function (d) {
    var x = decode_({ mapValue: { fields: d.fields || {} } });
    if (x._del || !x.maqId) return;
    out.push(x);
  });
  // una maquina = un lote abierto (si por error hubiera dos, queda el mas reciente)
  var porMaq = {};
  out.forEach(function (l) { if (!porMaq[l.maqId] || (l.ts || 0) > (porMaq[l.maqId].ts || 0)) porMaq[l.maqId] = l; });
  return Object.keys(porMaq).map(function (k) { return porMaq[k]; });
}

function cargarMateriales_() {
  var base = 'projects/' + PROYECTO + '/databases/(default)/documents/fichas/';
  var mats = {};
  ['SW-', 'STRUCT-'].forEach(function (pref) {
    var docs = runQuery_({
      from: [{ collectionId: 'fichas' }],
      select: { fields: ['header.referencia', 'header.tubosPorDocena', 'specs.pesoUnitarioGramos', 'specs.tiempoMin', 'specs.tiempoSeg', 'fibras', 'nombrePrenda']
        .map(function (p) { return { fieldPath: p }; }) },
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: base + pref } } },
        { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: { referenceValue: base + pref + '' } } }
      ] } }
    });
    docs.forEach(function (d) {
      var m = fichaToMaterial_(decode_({ mapValue: { fields: d.fields || {} } }));
      if (m) mats[m.code] = m;
    });
  });
  return mats;
}

// Igual que fichaToMaterial() de hilos.html
function fichaToMaterial_(d) {
  var h = d.header || {}, sp = d.specs || {};
  var code = String(h.referencia || '').trim().toUpperCase();
  var pesoTubo = parseFloat(sp.pesoUnitarioGramos);
  var tMin = parseFloat(sp.tiempoMin), tSeg = parseFloat(sp.tiempoSeg);
  var tPorTubo = (isNaN(tMin) ? 0 : tMin) + (isNaN(tSeg) ? 0 : tSeg) / 60;
  if (!code) return null;
  if (isNaN(pesoTubo) || pesoTubo <= 0) return null;
  var fibras = [];
  (d.fibras || []).forEach(function (f) {
    var pct = parseFloat(f.porcentaje);
    if (isNaN(pct) || pct <= 0) return;
    fibras.push({ nombre: f.nombre || '', titulo: f.titulo || (f.nombre || 'Sin titulo'), lote: f.lote || '',
      porcentaje: pct, itemS: f.itemS || '', itemZ: f.itemZ || '' });
  });
  if (!fibras.length) return null;
  return { code: code, nombre: String(d.nombrePrenda || code).trim(), pesoTuboG: pesoTubo,
    tiempoPorTuboMin: tPorTubo > 0 ? tPorTubo : null, fibras: fibras };
}

// Convierte los valores tipados de Firestore REST a objetos normales
function decode_(v) {
  if (v === null || v === undefined) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode_);
  if ('mapValue' in v) {
    var o = {}, f = v.mapValue.fields || {};
    Object.keys(f).forEach(function (k) { o[k] = decode_(f[k]); });
    return o;
  }
  return null;
}

// ----------------------------------------------------------------------
// Formato del correo
// ----------------------------------------------------------------------
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function num_(n, dec) {   // 1234.5 -> 1.234,50  (formato colombiano, sin depender de Intl)
  var p = Number(n).toFixed(dec).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return p.join(',');
}
function kg_(g) { return num_(g / 1000, 2); }
function itemTxt_(r) { var p = []; if (r.itemsS.length) p.push('S ' + r.itemsS.join(', ')); if (r.itemsZ.length) p.push('Z ' + r.itemsZ.join(', ')); return p.join(' / ') || '-'; }

function htmlPedido_(i) {
  var th = 'style="background:#0f2942;color:#fff;padding:8px 10px;text-align:left;font-size:12px"';
  var thr = 'style="background:#0f2942;color:#fff;padding:8px 10px;text-align:right;font-size:12px"';
  var h = '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px">';
  h += '<h2 style="margin:0 0 4px;color:#9a3412">PEDIDO DE HILO PARA HOY</h2>';
  h += '<div style="font-size:13px;color:#374151;margin-bottom:12px"><b>Fecha:</b> ' + i.fecha + ' &nbsp;|&nbsp; <b>Generado:</b> ' + i.hora +
    ' &nbsp;|&nbsp; <b>Proyección:</b> ' + i.horas + ' h al ' + i.eff + '% de eficiencia</div>';
  h += '<div style="background:#f3f4f6;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:14px">' +
    '<b>' + i.maquinas.length + '</b> máquinas montadas &nbsp;•&nbsp; <b style="font-size:16px">' + kg_(i.totalKg * 1000) + ' kg</b> de hilo en total</div>';

  if (!i.filas.length) {
    h += '<p style="color:#b91c1c"><b>No hay datos para calcular el pedido</b> (no hay máquinas montadas con ficha de hilo completa).</p>';
  } else {
    h += '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>' +
      '<th ' + th + '>#</th><th ' + th + '>Item (S / Z)</th><th ' + th + '>Título</th><th ' + th + '>Lote</th><th ' + th + '>Tipo de hilo</th><th ' + thr + '>Kilos</th></tr></thead><tbody>';
    i.filas.forEach(function (r, n) {
      var bg = n % 2 ? '#f9fafb' : '#ffffff';
      h += '<tr style="background:' + bg + '"><td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280">' + (n + 1) + '</td>' +
        '<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">' + esc_(itemTxt_(r)) + '</td>' +
        '<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-weight:bold">' + esc_(r.titulo) + '</td>' +
        '<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb">' + esc_(r.lote || '-') + '</td>' +
        '<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#4b5563">' + esc_(r.nombre) + '</td>' +
        '<td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:bold;font-size:14px">' + kg_(r.gramos) + '</td></tr>';
    });
    h += '<tr style="background:#fef3c7"><td colspan="5" style="padding:9px 10px;font-weight:bold">TOTAL</td><td style="padding:9px 10px;text-align:right;font-weight:bold;font-size:15px">' + kg_(i.totalKg * 1000) + ' kg</td></tr>';
    h += '</tbody></table>';
  }

  if (i.sinFicha.length || i.sinTiempo.length) {
    h += '<div style="margin-top:14px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:12.5px;color:#991b1b">' +
      '<b>⚠ Estas máquinas NO están incluidas en el pedido:</b>' +
      (i.sinFicha.length ? '<br>Sin ficha de hilo: ' + esc_(i.sinFicha.join(', ')) : '') +
      (i.sinTiempo.length ? '<br>Sin tiempo por tubo: ' + esc_(i.sinTiempo.join(', ')) : '') + '</div>';
  }

  if (i.maquinas.length) {
    h += '<h3 style="margin:20px 0 6px;font-size:14px;color:#0f2942">Máquinas montadas</h3>' +
      '<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr><th ' + th + '>Máquina</th><th ' + th + '>Referencia</th><th ' + th + '>Nombre</th><th ' + thr + '>Tubos proyectados</th></tr></thead><tbody>';
    i.maquinas.forEach(function (m, n) {
      h += '<tr style="background:' + (n % 2 ? '#f9fafb' : '#fff') + '"><td style="padding:5px 10px;border-bottom:1px solid #eef0f2;font-weight:bold">' + esc_(m.maq) + (m.parada ? ' ⏸' : '') + '</td>' +
        '<td style="padding:5px 10px;border-bottom:1px solid #eef0f2">' + esc_(m.ref) + '</td><td style="padding:5px 10px;border-bottom:1px solid #eef0f2;color:#4b5563">' + esc_(m.nombre) +
        '</td><td style="padding:5px 10px;border-bottom:1px solid #eef0f2;text-align:right">' + num_(m.tubos, 0) + '</td></tr>';
    });
    h += '</tbody></table><div style="font-size:11px;color:#6b7280;margin-top:4px">⏸ = máquina montada pero parada en este momento (se incluye igual).</div>';
  }

  h += '<p style="font-size:11.5px;color:#6b7280;margin-top:18px">Cálculo automático: tubos por hora según el tiempo estándar de cada referencia × horas × eficiencia × peso del tubo × % de cada hilo en la ficha. ' +
    'Es una proyección, no el consumo real. Generado automáticamente por el Ecosistema Swantex.</p></div>';
  return h;
}

function textoPedido_(i) {
  var t = 'PEDIDO DE HILO PARA HOY - ' + i.fecha + ' (' + i.hora + ')\n';
  t += i.maquinas.length + ' maquinas montadas | proyeccion ' + i.horas + ' h al ' + i.eff + '%\n\n';
  t += 'ITEM | TITULO | LOTE | TIPO | KILOS\n';
  i.filas.forEach(function (r) { t += itemTxt_(r) + ' | ' + r.titulo + ' | ' + (r.lote || '-') + ' | ' + r.nombre + ' | ' + kg_(r.gramos) + '\n'; });
  t += '\nTOTAL: ' + kg_(i.totalKg * 1000) + ' kg\n';
  if (i.sinFicha.length) t += '\nSin ficha de hilo (no incluidas): ' + i.sinFicha.join(', ') + '\n';
  if (i.sinTiempo.length) t += 'Sin tiempo por tubo (no incluidas): ' + i.sinTiempo.join(', ') + '\n';
  return t;
}

/*
 * INSTALACION (5 minutos, una sola vez)
 * 1. Entre a https://script.google.com con jdposada33@gmail.com > Nuevo proyecto
 *    (nombre: "Pedido de hilo Swantex"). Borre el codigo de ejemplo y pegue TODO este archivo.
 * 2. Arriba, en DESTINATARIOS, escriba el correo de materia prima. Guarde (Ctrl+S).
 * 3. En el menu de funciones elija  enviarPedidoPrueba  > Ejecutar.
 *    Google pedira permisos (enviar correos y conectarse a internet): Revisar permisos >
 *    su cuenta > Avanzado > Ir a "Pedido de hilo Swantex" > Permitir.
 *    Le llega un correo [PRUEBA] solo a usted. Revise que las cifras tengan sentido.
 * 4. Elija  instalarDisparador  > Ejecutar. Listo: sale todos los dias a las 8:00 a.m.
 *    (para verificar: icono del reloj "Activadores" a la izquierda).
 * Para cambiar la hora: modifique HORA_ENVIO y ejecute instalarDisparador otra vez.
 */
