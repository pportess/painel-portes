// Ponte entre o painel e o Supabase.
// O painel foi feito para o claude.ai e pede tudo por window.claude.use('db' | 'assets' | 'downloads' | 'mcp').
// Aqui a mesma conversa é atendida pelo Supabase, depois do login, sem mudar o resto do código.
(function () {
  var cfg = window.PAINEL_CONFIG;
  var sb = window.supabase.createClient(cfg.url, cfg.key);
  var BUCKET = 'midia';
  var urls = {};            // id do arquivo -> link assinado (vale 1 dia)
  var subs = [];            // consultas abertas, refeitas quando algo muda

  // ---------- login ----------
  var liberar;
  var pronto = new Promise(function (r) { liberar = r; });

  function tela(html) {
    var el = document.getElementById('ponte-login');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ponte-login';
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="pl-card"><div class="pl-marca">Consultório</div>' + html + '</div>';
    return el;
  }
  function fecharTela() { var el = document.getElementById('ponte-login'); if (el) el.remove(); }

  function pedirEmail(msg) {
    var el = tela('<h1>Entrar no painel</h1><p>Digite o seu e-mail. Mandamos um link de acesso, sem senha.</p>' +
      '<form><input type="email" required autocomplete="email" placeholder="seu@email.com"><button>Mandar o link</button></form>' +
      (msg ? '<p class="pl-msg">' + msg + '</p>' : ''));
    el.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = el.querySelector('input').value.trim();
      var bt = el.querySelector('button'); bt.disabled = true; bt.textContent = 'Mandando…';
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
        if (r.error) {
          pedirEmail(/rate|limit/i.test(r.error.message) ? 'Muitos pedidos seguidos. Espere alguns minutos e tente de novo.' : 'Não deu para mandar: ' + r.error.message);
          return;
        }
        tela('<h1>Confira o seu e-mail</h1><p>Mandamos um link para <b>' + email.replace(/</g, '&lt;') + '</b>. Abra o link neste mesmo aparelho para entrar.</p>' +
          '<button type="button" class="pl-sec">Usar outro e-mail</button>').querySelector('button').addEventListener('click', function () { pedirEmail(); });
      });
    });
  }

  function entrou() {
    sb.rpc('e_dono').then(function (r) {
      if (r.error) { pedirEmail('O banco ainda não foi preparado (falta rodar o banco.sql no Supabase).'); return; }
      if (!r.data) { sb.auth.signOut(); pedirEmail('Este e-mail não tem acesso ao painel.'); return; }
      fecharTela(); ligarAoVivo(); liberar(true);
    });
  }

  var jaEntrou = false;
  sb.auth.onAuthStateChange(function (ev, sessao) {
    if (sessao && !jaEntrou) { jaEntrou = true; setTimeout(entrou, 0); }
  });
  sb.auth.getSession().then(function (r) {
    if (!r.data.session) pedirEmail();
  });

  window.painelSair = function () { sb.auth.signOut().then(function () { location.reload(); }); };

  // ---------- links dos arquivos ----------
  function assetsDe(data, out) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.asset === 'string' && !urls[data.asset]) out.push(data.asset);
    if (data.edicao && typeof data.edicao.asset === 'string' && !urls[data.edicao.asset]) out.push(data.edicao.asset);
  }
  function assinar(ids) {
    ids = ids.filter(function (id, i) { return ids.indexOf(id) === i; });
    if (!ids.length) return Promise.resolve();
    return sb.storage.from(BUCKET).createSignedUrls(ids, 86400).then(function (r) {
      (r.data || []).forEach(function (x) { if (x.signedUrl && x.path) urls[x.path] = x.signedUrl; });
    });
  }
  window.painelBlobUrl = function (id) { return urls[id] || ''; };

  // ---------- banco (documentos) ----------
  function partes(p) { var i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; }
  function snapDoc(id, row) { return { id: id, exists: !!row, data: function () { return row ? row.data : undefined; } }; }
  function erro(e) { var x = new Error(e && e.message || 'erro'); x.code = e && e.code || 'error'; return x; }
  function ok(r) { if (r.error) throw erro(r.error); return r.data; }

  var timers = {};
  function refazer(col) {
    clearTimeout(timers[col]);
    timers[col] = setTimeout(function () { subs.forEach(function (s) { if (s.col === col) s.run(); }); }, 120);
  }

  function lerDoc(col, id) {
    return sb.from('docs').select('data,version').eq('col', col).eq('id', id).maybeSingle().then(ok);
  }

  function doc(p) {
    var s = partes(p), col = s[0], id = s[1];
    return {
      get: function () { return lerDoc(col, id).then(function (row) { return snapDoc(id, row); }); },
      set: function (body) {
        return sb.from('docs').upsert({ col: col, id: id, data: body }).then(ok).then(function () { refazer(col); });
      },
      update: function (patch) {
        return lerDoc(col, id).then(function (row) {
          if (!row) throw erro({ code: 'not_found', message: 'documento não existe' });
          return sb.from('docs').update({ data: Object.assign({}, row.data, patch) }).eq('col', col).eq('id', id).eq('version', row.version).select('id').then(ok);
        }).then(function (linhas) {
          if (!linhas || !linhas.length) throw erro({ code: 'conflict', message: 'mudou enquanto salvava' });
          refazer(col);
        });
      },
      delete: function () { return sb.from('docs').delete().eq('col', col).eq('id', id).then(ok).then(function () { refazer(col); }); },
      onSnapshot: function (fn, onErr) {
        var sub = { col: col, run: function () {
          lerDoc(col, id).then(function (row) { if (!sub.off) fn(snapDoc(id, row)); }, function (e) { if (onErr && !sub.off) onErr(erro(e)); });
        } };
        subs.push(sub); sub.run();
        return function () { sub.off = true; subs.splice(subs.indexOf(sub), 1); };
      }
    };
  }

  function collection(col) {
    var ordem = null, lim = 1000;
    var q = {
      orderBy: function (campo, dir) { ordem = { campo: campo, desc: dir === 'desc' }; return q; },
      limit: function (n) { lim = n; return q; },
      onSnapshot: function (fn, onErr) {
        var sub = { col: col, run: function () {
          sb.from('docs').select('id,data').eq('col', col).limit(1000).then(ok).then(function (rows) {
            if (ordem) rows.sort(function (a, b) {
              var x = a.data[ordem.campo], y = b.data[ordem.campo];
              var c = x === y ? 0 : x === undefined ? -1 : y === undefined ? 1 : x < y ? -1 : 1;
              return ordem.desc ? -c : c;
            });
            rows = rows.slice(0, lim);
            var falta = []; rows.forEach(function (r) { assetsDe(r.data, falta); });
            return assinar(falta).then(function () { return rows; });
          }).then(function (rows) {
            if (!sub.off) fn({ docs: rows.map(function (r) { return snapDoc(r.id, r); }), metadata: { fromCache: false } });
          }, function (e) { if (onErr && !sub.off) onErr(erro(e)); });
        } };
        subs.push(sub); sub.run();
        return function () { sub.off = true; subs.splice(subs.indexOf(sub), 1); };
      }
    };
    return q;
  }

  function ligarAoVivo() {
    sb.channel('docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, function (p) {
      var col = (p.new && p.new.col) || (p.old && p.old.col);
      if (col) refazer(col); else subs.forEach(function (s) { refazer(s.col); });
    }).subscribe();
    // ao voltar para a aba (celular), confere se algo mudou
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) subs.map(function (s) { return s.col; }).forEach(refazer);
    });
  }

  // ---------- arquivos ----------
  function novoId() {
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  var assets = {
    upload: function (blob, o) {
      var id = novoId(), tipo = (o && o.type) || blob.type;
      return sb.storage.from(BUCKET).upload(id, blob, { contentType: tipo, upsert: false }).then(function (r) {
        if (r.error) throw erro({ code: /size|large/i.test(r.error.message) ? 'too_large' : 'upload', message: r.error.message });
        return assinar([id]);
      }).then(function () { return { id: id, url: urls[id] || '', sizeBytes: blob.size, contentType: tipo }; });
    },
    list: function () {
      return sb.storage.from(BUCKET).list('', { limit: 1000 }).then(ok).then(function (a) {
        a = a.filter(function (x) { return x.id; });
        var bytes = a.reduce(function (s, x) { return s + ((x.metadata && x.metadata.size) || 0); }, 0);
        return { assets: a.map(function (x) { return { id: x.name, sizeBytes: x.metadata && x.metadata.size, contentType: x.metadata && x.metadata.mimetype }; }),
          usage: { files: a.length, bytes: bytes, maxFiles: 5000, maxBytes: 1073741824 } };
      });
    },
    delete: function (id) { return sb.storage.from(BUCKET).remove([id]).then(ok).then(function () { delete urls[id]; return { deleted: true }; }); }
  };

  var downloads = {
    save: function (r) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(r.data); a.download = r.filename || 'arquivo';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      return Promise.resolve({});
    }
  };

  var db = { doc: doc, collection: collection };

  window.claude = {
    use: function (nome) {
      return pronto.then(function () {
        if (nome === 'db') return db;
        if (nome === 'assets') return assets;
        if (nome === 'downloads') return downloads;
        return null; // Google Agenda: próxima etapa
      });
    }
  };
})();
