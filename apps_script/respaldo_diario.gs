/**
 * COPIA DE SEGURIDAD DIARIA - Base de datos de planta
 * ------------------------------------------------------------
 * Cada noche copia TODA la base de datos (produccion, fichas, maquinas,
 * personal, documentos) a una carpeta de Google Drive, una carpeta por dia.
 *
 *   - Guarda los ultimos DIAS_A_GUARDAR dias y borra los mas viejos.
 *   - Avisa por correo si la copia falla o si de un dia para otro
 *     desaparecen muchos registros (posible borrado por error).
 *   - Permite devolver un registro, los que falten, o todo.
 *
 * INSTALACION (una sola vez): ver instrucciones al final del archivo.
 */

// ===================== CONFIGURACION (edite aqui) =====================
var PROYECTO = 'swantex-produccion';     // proyecto de Firebase
var COLECCION = 'fichas';                // coleccion que se copia
var CARPETA = 'Respaldo base de datos planta'; // carpeta en Google Drive
var DIAS_A_GUARDAR = 30;                 // copias diarias que se conservan
var HORA = 2;                            // hora de la copia (2 = 2:00 am)
var AVISAR_A = '';                       // correo de avisos ('' = el dueno del script)
var ALERTA_CAIDA = 10;                   // % de registros perdidos que dispara alerta
var RESUMEN_SEMANAL = true;              // correo cada lunes confirmando que todo va bien

// --- Solo para RESTAURAR (ver instrucciones al final) ---
var RESTAURAR_FECHA = '';                // carpeta del dia a usar, ej: '2026-11-09'
var RESTAURAR_ID = '';                   // id del registro, ej: 'LOTE-abc123'
var CONFIRMO_RESTAURAR_TODO = 'NO';      // escriba 'SI' solo para restaurarTodo
// ======================================================================

var BASE_ = 'https://firestore.googleapis.com/v1/projects/' + PROYECTO + '/databases/(default)/documents';
var PAGINA_ = 300;                 // registros por consulta (baja sola si son muy pesados)
var MAX_PARTE_ = 12 * 1024 * 1024; // tamano de cada archivo antes de comprimir
var MAX_MS_ = 4.5 * 60 * 1000;     // Apps Script corta a los 6 min: se pausa antes y continua solo

/** Hace la copia del dia. La llama el disparador; tambien se puede ejecutar a mano. */
function respaldoDiario() {
  var props = PropertiesService.getScriptProperties();
  var est = JSON.parse(props.getProperty('estado') || 'null');
  var t0 = Date.now();
  try {
    if (!est) {
      var dia = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      var raiz = carpetaRaiz_();
      var viejas = raiz.getFoldersByName(dia);
      while (viejas.hasNext()) viejas.next().setTrashed(true); // si se repite el mismo dia, reemplaza
      est = { dia: dia, carpeta: raiz.createFolder(dia).getId(), cursor: '', parte: 0, total: 0, bytes: 0, tipos: {} };
    }
    var carpeta = DriveApp.getFolderById(est.carpeta);
    var lote = [], peso = 0, pag = PAGINA_, fin = false;

    while (!fin) {
      var r = consultar_(est.cursor, pag);
      if (r.reducir) { if (pag === 1) throw new Error('Un registro pesa mas de lo que se puede leer: despues de ' + est.cursor); pag = Math.max(1, Math.floor(pag / 4)); continue; }
      r.docs.forEach(function (d) {
        lote.push(d);
        var id = d.name.split('/').pop(), t = prefijo_(id);
        est.tipos[t] = (est.tipos[t] || 0) + 1;
      });
      peso += r.bytes; est.total += r.docs.length; est.bytes += r.bytes;
      if (r.docs.length) est.cursor = r.docs[r.docs.length - 1].name;
      fin = r.docs.length < pag;
      if (r.bytes > MAX_PARTE_ && pag > 1) pag = Math.max(1, Math.floor(pag / 4));        // registros pesados: pide de a menos
      else if (pag < PAGINA_ && r.bytes < 3 * 1024 * 1024) pag = Math.min(PAGINA_, pag * 2);

      var seAcabaElTiempo = Date.now() - t0 > MAX_MS_;
      if (peso > MAX_PARTE_ || fin || seAcabaElTiempo) {
        if (lote.length) { est.parte++; guardarParte_(carpeta, est.parte, lote); }
        lote = []; peso = 0;
      }
      if (seAcabaElTiempo && !fin) {           // pausa y sigue en 1 minuto donde quedo
        props.setProperty('estado', JSON.stringify(est));
        borrarDisparadores_('continuarRespaldo');
        ScriptApp.newTrigger('continuarRespaldo').timeBased().after(60 * 1000).create();
        return;
      }
    }

    props.deleteProperty('estado');
    borrarDisparadores_('continuarRespaldo');
    carpeta.createFile('resumen.json', JSON.stringify({ dia: est.dia, registros: est.total, bytes: est.bytes, partes: est.parte, tipos: est.tipos, proyecto: PROYECTO }, null, 1), 'application/json');
    cerrar_(est);
  } catch (err) {
    props.deleteProperty('estado');
    avisar_('⚠️ FALLO la copia de seguridad de la base de datos',
      'La copia de hoy no se pudo terminar.\n\nError: ' + (err && err.message || err) +
      '\n\nEntre a script.google.com, abra el proyecto de la copia y ejecute "respaldoDiario" a mano. Si vuelve a fallar, revise el error en "Ejecuciones".');
    throw err;
  }
}
function continuarRespaldo() { respaldoDiario(); }

/** Revisa la copia contra la de ayer, limpia las viejas y avisa si algo esta raro. */
function cerrar_(est) {
  var props = PropertiesService.getScriptProperties();
  var ant = JSON.parse(props.getProperty('ultimo') || 'null');
  props.setProperty('ultimo', JSON.stringify({ dia: est.dia, total: est.total, tipos: est.tipos }));

  var borradas = limpiar_();
  var mb = (est.bytes / 1048576).toFixed(1);
  Logger.log('Copia ' + est.dia + ': ' + est.total + ' registros, ' + mb + ' MB, ' + est.parte + ' archivo(s). Copias viejas borradas: ' + borradas);

  if (est.total === 0) {
    avisar_('⚠️ La copia de seguridad salio VACIA', 'La copia del ' + est.dia + ' no encontro ningun registro en la base de datos. Revise de inmediato: puede que la base este vacia o que no se pueda leer.');
    return;
  }
  if (ant && ant.dia !== est.dia && ant.total > 0) {
    var caidas = [];
    var pct = (ant.total - est.total) * 100 / ant.total;
    if (pct >= ALERTA_CAIDA) caidas.push('TOTAL: de ' + ant.total + ' a ' + est.total + ' (-' + pct.toFixed(0) + '%)');
    Object.keys(ant.tipos || {}).forEach(function (t) {
      var a = ant.tipos[t], b = est.tipos[t] || 0;
      if (a >= 20 && (a - b) * 100 / a >= ALERTA_CAIDA) caidas.push(nombreTipo_(t) + ': de ' + a + ' a ' + b);
    });
    if (caidas.length) {
      avisar_('⚠️ Desaparecieron registros de la base de datos',
        'Entre la copia del ' + ant.dia + ' y la del ' + est.dia + ' bajo la cantidad de registros:\n\n  ' + caidas.join('\n  ') +
        '\n\nSi nadie borro eso a proposito, puede recuperarlo: en el script ponga RESTAURAR_FECHA = \'' + ant.dia + '\' y ejecute "restaurarFaltantes".\nLa copia del ' + ant.dia + ' sigue guardada en la carpeta "' + CARPETA + '" de Google Drive.');
      return;
    }
  }
  if (RESUMEN_SEMANAL && new Date().getDay() === 1) {
    var lineas = Object.keys(est.tipos).sort(function (a, b) { return est.tipos[b] - est.tipos[a]; }).map(function (t) { return '  ' + nombreTipo_(t) + ': ' + est.tipos[t]; });
    avisar_('✅ Copia de seguridad al dia (' + est.dia + ')',
      'La copia diaria de la base de datos esta funcionando.\n\nUltima copia: ' + est.dia + '\nRegistros: ' + est.total + '\nTamano: ' + mb + ' MB\n\n' + lineas.join('\n') +
      '\n\nSe conservan los ultimos ' + DIAS_A_GUARDAR + ' dias en la carpeta "' + CARPETA + '" de Google Drive.');
  }
}

/* ======================= RESTAURAR ======================= */

/** Muestra en el registro las copias que hay guardadas. */
function verCopias() {
  var it = carpetaRaiz_().getFolders(), l = [];
  while (it.hasNext()) { var f = it.next(); if (/^\d{4}-\d{2}-\d{2}$/.test(f.getName())) l.push(f.getName()); }
  l.sort().reverse();
  Logger.log(l.length ? 'Copias guardadas (' + l.length + '):\n' + l.join('\n') : 'Todavia no hay copias.');
  return l;
}

/** Devuelve UN registro tal como estaba en la copia de RESTAURAR_FECHA (lo sobrescribe). */
function restaurarDocumento() {
  if (!RESTAURAR_ID) throw new Error('Escriba el id del registro en RESTAURAR_ID.');
  var ok = false;
  recorrerCopia_(function (d) {
    if (d.name.split('/').pop() !== RESTAURAR_ID) return;
    escribir_(d); ok = true; return true;
  });
  Logger.log(ok ? 'Restaurado: ' + RESTAURAR_ID : 'Ese registro NO esta en la copia del ' + RESTAURAR_FECHA);
}

/** Devuelve solo los registros que estan en la copia y ya NO estan en la base. No toca lo que existe. */
function restaurarFaltantes() {
  var actuales = {}, cursor = '', pag = PAGINA_;
  while (true) {
    var r = consultar_(cursor, pag, true);
    r.docs.forEach(function (d) { actuales[d.name] = 1; });
    if (r.docs.length < pag) break;
    cursor = r.docs[r.docs.length - 1].name;
  }
  var n = 0, vistos = 0;
  recorrerCopia_(function (d) { vistos++; if (!actuales[d.name]) { escribir_(d); n++; } });
  Logger.log('Registros en la copia: ' + vistos + '. Faltaban y se devolvieron: ' + n);
}

/** Sobrescribe TODO con la copia de RESTAURAR_FECHA. Se pierde lo hecho despues de esa fecha. */
function restaurarTodo() {
  if (CONFIRMO_RESTAURAR_TODO !== 'SI') throw new Error('Para restaurar todo escriba CONFIRMO_RESTAURAR_TODO = \'SI\'. Ojo: se pierde lo registrado despues de la fecha de la copia.');
  var n = 0;
  recorrerCopia_(function (d) { escribir_(d); n++; });
  Logger.log('Restaurados ' + n + ' registros desde la copia del ' + RESTAURAR_FECHA + '. Vuelva a poner CONFIRMO_RESTAURAR_TODO = \'NO\'.');
}

/* ======================= PIEZAS ======================= */

/** Lee una pagina de registros ordenados por id, a partir del ultimo leido. */
function consultar_(cursor, limite, soloIds) {
  var q = { from: [{ collectionId: COLECCION }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: limite };
  if (cursor) q.startAt = { values: [{ referenceValue: cursor }], before: false };
  if (soloIds) q.select = { fields: [{ fieldPath: '__name__' }] };
  var resp, txt;
  try {
    resp = UrlFetchApp.fetch(BASE_ + ':runQuery', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ structuredQuery: q }), muteHttpExceptions: true });
    txt = resp.getContentText();
  } catch (e) {
    if (limite > 1) return { reducir: true };   // respuesta demasiado grande: se pide de a menos
    throw e;
  }
  var cod = resp.getResponseCode();
  if (cod !== 200) throw new Error('La base de datos respondio ' + cod + ': ' + txt.slice(0, 300));
  var docs = [];
  JSON.parse(txt).forEach(function (x) {
    if (x.document) docs.push({ name: x.document.name, fields: x.document.fields || {}, createTime: x.document.createTime, updateTime: x.document.updateTime });
  });
  return { docs: docs, bytes: txt.length };
}

function guardarParte_(carpeta, n, docs) {
  var nombre = 'parte-' + ('00' + n).slice(-3) + '.json';
  var blob = Utilities.newBlob(JSON.stringify(docs), 'application/json', nombre);
  carpeta.createFile(Utilities.gzip(blob, nombre + '.gz'));
}

/** Pasa por todos los registros de la copia de RESTAURAR_FECHA. Si fn devuelve true, se detiene. */
function recorrerCopia_(fn) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(RESTAURAR_FECHA)) throw new Error('Escriba la fecha de la copia en RESTAURAR_FECHA, asi: 2026-11-09. Ejecute "verCopias" para ver cuales hay.');
  var it = carpetaRaiz_().getFoldersByName(RESTAURAR_FECHA);
  if (!it.hasNext()) throw new Error('No hay copia del ' + RESTAURAR_FECHA + '. Ejecute "verCopias" para ver cuales hay.');
  var archivos = [], fi = it.next().getFiles();
  while (fi.hasNext()) { var f = fi.next(); if (/^parte-\d+\.json\.gz$/.test(f.getName())) archivos.push(f); }
  archivos.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  if (!archivos.length) throw new Error('La copia del ' + RESTAURAR_FECHA + ' no tiene archivos.');
  for (var i = 0; i < archivos.length; i++) {
    var docs = JSON.parse(Utilities.ungzip(archivos[i].getBlob().setContentType('application/x-gzip')).getDataAsString());
    for (var j = 0; j < docs.length; j++) if (fn(docs[j]) === true) return;
  }
}

function escribir_(d) {
  var ruta = d.name.split('/documents/')[1].split('/').map(encodeURIComponent).join('/');
  var r = UrlFetchApp.fetch(BASE_ + '/' + ruta, { method: 'patch', contentType: 'application/json', payload: JSON.stringify({ fields: d.fields }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('No se pudo devolver ' + d.name.split('/').pop() + ': ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}

function limpiar_() {
  var it = carpetaRaiz_().getFolders(), l = [];
  while (it.hasNext()) { var f = it.next(); if (/^\d{4}-\d{2}-\d{2}$/.test(f.getName())) l.push(f); }
  l.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  var n = 0;
  for (var i = DIAS_A_GUARDAR; i < l.length; i++) { l[i].setTrashed(true); n++; }
  return n;
}

function carpetaRaiz_() {
  var it = DriveApp.getFoldersByName(CARPETA);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CARPETA);
}

function prefijo_(id) {
  var m = /^(RH-[A-Z]+|SWAN2|[A-Z0-9]+)-/.exec(id);
  return m ? m[1] : 'OTROS';
}
function nombreTipo_(t) {
  var n = { LOTE: 'Lotes de produccion', SW: 'Fichas / precosteos', STRUCT: 'Estructuras', MAQNOTA: 'Notas de maquinas', MAQFOTO: 'Fotos de maquinas',
    'RH-P': 'Personas', 'RH-N': 'Novedades de personal', 'RH-T': 'Turnos', 'RH-M': 'Timbradas', 'RH-A': 'Documentos de personal', 'RH-AC': 'Documentos de personal (contenido)',
    SWAN2: 'Configuracion' };
  return n[t] || t;
}

function avisar_(asunto, texto) {
  var para = AVISAR_A || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: para, subject: asunto, body: texto });
}

function borrarDisparadores_(fn) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

/** Programa la copia para todos los dias a la HORA configurada. Ejecutar una sola vez. */
function instalarDisparador() {
  borrarDisparadores_('respaldoDiario');
  ScriptApp.newTrigger('respaldoDiario').timeBased().everyDays(1).atHour(HORA).create();
  Logger.log('Listo: la copia se hara todos los dias entre las ' + HORA + ':00 y las ' + (HORA + 1) + ':00.');
}

/* ============================================================
   INSTALACION (una sola vez, 5 minutos)

   1. Entre a script.google.com con la cuenta de Google en cuyo Drive
      quiere guardar las copias. Proyecto nuevo: "Copia de seguridad planta".
   2. Borre lo que trae el editor y pegue TODO este archivo. Guarde.
   3. Elija la funcion "respaldoDiario" y oprima Ejecutar. Acepte los
      permisos (Configuracion avanzada > Ir a ... > Permitir).
      Al terminar, en Google Drive aparece la carpeta
      "Respaldo base de datos planta" con una carpeta con la fecha de hoy.
   4. Elija "instalarDisparador" y oprima Ejecutar. Desde ahi la copia
      se hace sola todas las madrugadas.

   COMO RECUPERAR
   - Ver que copias hay:            ejecute "verCopias".
   - Se borro algo por error:       RESTAURAR_FECHA = 'fecha de la copia buena'
                                    y ejecute "restaurarFaltantes". Devuelve solo
                                    lo que falta; no toca lo que existe.
   - Un registro quedo danado:      RESTAURAR_FECHA y RESTAURAR_ID, ejecute
                                    "restaurarDocumento".
   - Devolver todo a una fecha:     "restaurarTodo" (pide confirmacion; se pierde
                                    lo registrado despues de esa fecha).

   NOTA: cuando se cierre la base de datos con inicio de sesion, este script
   necesita un ajuste para identificarse. Avise antes de cerrar las reglas.
   ============================================================ */
