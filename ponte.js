// Ponte entre o painel e o Supabase.
// O painel foi feito para o claude.ai e pede tudo por window.claude.use('db' | 'assets' | 'downloads' | 'mcp').
// Aqui a mesma conversa é atendida pelo Supabase, depois do login, sem mudar o resto do código.
(function () {
  var cfg = window.PAINEL_CONFIG;
  var hashInicial = location.hash; // lido antes do Supabase limpar o endereço
  var sb = window.supabase.createClient(cfg.url, cfg.key);
  var BUCKET = 'midia';
  var urls = {};            // id do arquivo -> link assinado (vale 1 dia)
  var subs = [];            // consultas abertas, refeitas quando algo muda

  // ---------- login: usuário e senha; conta nova só entra depois que o Pedro aprova ----------
  var liberar;
  var pronto = new Promise(function (r) { liberar = r; });
  var aqui = location.origin + location.pathname;

  // o script roda no <head>: as telas só podem ser montadas depois que a página existir
  function quandoPronto(fn) {
    if (document.body) setTimeout(fn, 0);
    else document.addEventListener('DOMContentLoaded', function () { fn(); });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tela(html) {
    var el = document.getElementById('ponte-login');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ponte-login';
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="pl-card"><div class="pl-marca">Consultório</div>' + html + '</div>';
    el.querySelectorAll('[data-ir]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); ({ entrar: entrar, criar: criarConta, esqueci: esqueci, sair: sair })[a.getAttribute('data-ir')](); });
    });
    return el;
  }
  function fecharTela() { var el = document.getElementById('ponte-login'); if (el) el.remove(); }
  function msgHtml(msg, ok) { return msg ? '<p class="pl-msg' + (ok ? ' pl-ok' : '') + '">' + esc(msg) + '</p>' : ''; }
  function ocupado(form, texto) { var b = form.querySelector('button'); b.disabled = true; b.textContent = texto; }
  function traduz(m) {
    m = String(m || '');
    if (/invalid login/i.test(m)) return 'Usuário ou senha errados.';
    if (/not confirmed/i.test(m)) return 'Falta confirmar o e-mail: abra o link que mandamos na sua caixa de entrada.';
    if (/rate|limit|seconds/i.test(m)) return 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.';
    if (/password.*(short|least|characters)/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (/same.*password|different from the old/i.test(m)) return 'A senha nova precisa ser diferente da antiga.';
    return 'Não deu certo: ' + m;
  }

  function entrar(msg, ok) {
    var el = tela('<h1>Entrar no painel</h1>' +
      '<form><label>Usuário ou e-mail<input name="u" required autocomplete="username" autocapitalize="none"></label>' +
      '<label>Senha<input name="s" type="password" required autocomplete="current-password"></label><button>Entrar</button></form>' +
      msgHtml(msg, ok) +
      '<p class="pl-links"><a href="#" data-ir="esqueci">Esqueci a senha</a> · <a href="#" data-ir="criar">Criar conta</a></p>');
    var f = el.querySelector('form');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var u = f.u.value.trim(), s = f.s.value;
      ocupado(f, 'Entrando…');
      var email = u.indexOf('@') > 0 ? Promise.resolve(u) : sb.rpc('email_para_login', { p_usuario: u }).then(function (r) { return r.data || null; });
      email.then(function (em) {
        if (!em) { entrar('Usuário ou senha errados.'); return; }
        return sb.auth.signInWithPassword({ email: em, password: s }).then(function (r) { if (r.error) entrar(traduz(r.error.message)); });
      });
    });
  }

  function criarConta(msg) {
    var el = tela('<h1>Criar conta</h1><p>Depois de criar, o Pedro recebe o seu pedido. Você só entra no painel quando ele aprovar.</p>' +
      '<form><label>Nome<input name="n" required autocomplete="name"></label>' +
      '<label>Usuário<input name="u" required autocapitalize="none" pattern="[A-Za-z0-9._\\-]{3,30}" title="3 a 30 letras, números, ponto, traço ou sublinhado, sem espaço"></label>' +
      '<label>E-mail<input name="e" type="email" required autocomplete="email"></label>' +
      '<label>Senha (pelo menos 8 caracteres)<input name="s" type="password" required minlength="8" autocomplete="new-password"></label>' +
      '<label>Repita a senha<input name="s2" type="password" required minlength="8" autocomplete="new-password"></label><button>Criar conta</button></form>' +
      msgHtml(msg) + '<p class="pl-links"><a href="#" data-ir="entrar">Já tenho conta</a></p>');
    var f = el.querySelector('form');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (f.s.value !== f.s2.value) { criarConta('As duas senhas não são iguais.'); return; }
      var dados = { nome: f.n.value.trim(), usuario: f.u.value.trim().toLowerCase(), email: f.e.value.trim(), senha: f.s.value };
      ocupado(f, 'Criando…');
      sb.rpc('usuario_livre', { p_usuario: dados.usuario }).then(function (r) {
        if (r.error) { criarConta(traduz(r.error.message)); return; }
        if (!r.data) { criarConta('Esse usuário já existe. Escolha outro.'); return; }
        return sb.auth.signUp({ email: dados.email, password: dados.senha, options: { emailRedirectTo: aqui, data: { nome: dados.nome, usuario: dados.usuario } } }).then(function (r2) {
          if (r2.error) { criarConta(traduz(r2.error.message)); return; }
          if (r2.data.session) return; // sem confirmação de e-mail: já entra e cai na tela de espera
          tela('<h1>Confirme o seu e-mail</h1><p>Mandamos um link para <b>' + esc(dados.email) + '</b>. Abra o link para confirmar a conta.</p>' +
            '<p>Depois disso, o Pedro recebe o seu pedido. Você entra no painel quando ele aprovar.</p><p class="pl-links"><a href="#" data-ir="entrar">Voltar para o login</a></p>');
        });
      });
    });
  }

  function esqueci(msg) {
    var el = tela('<h1>Esqueci a senha</h1><p>Digite o e-mail da sua conta. Mandamos um link para você criar uma senha nova.</p>' +
      '<form><label>E-mail<input name="e" type="email" required autocomplete="email"></label><button>Mandar o link</button></form>' +
      msgHtml(msg) + '<p class="pl-links"><a href="#" data-ir="entrar">Voltar para o login</a></p>');
    var f = el.querySelector('form');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var em = f.e.value.trim();
      ocupado(f, 'Mandando…');
      sb.auth.resetPasswordForEmail(em, { redirectTo: aqui }).then(function (r) {
        if (r.error) { esqueci(traduz(r.error.message)); return; }
        tela('<h1>Confira o seu e-mail</h1><p>Se existir uma conta com <b>' + esc(em) + '</b>, mandamos um link. Abra o link neste mesmo aparelho para criar a senha nova.</p>' +
          '<p class="pl-links"><a href="#" data-ir="entrar">Voltar para o login</a></p>');
      });
    });
  }

  function novaSenha(msg) {
    meuPerfil().then(function (p) {
      var el = tela('<h1>Criar senha nova</h1><p>Escolha o seu usuário e a senha que vai usar para entrar.</p>' +
        '<form><label>Usuário<input name="u" required autocapitalize="none" pattern="[A-Za-z0-9._\\-]{3,30}" title="3 a 30 letras, números, ponto, traço ou sublinhado, sem espaço" value="' + esc(p && p.usuario || '') + '"></label>' +
        '<label>Senha nova (pelo menos 8 caracteres)<input name="s" type="password" required minlength="8" autocomplete="new-password"></label>' +
        '<label>Repita a senha<input name="s2" type="password" required minlength="8" autocomplete="new-password"></label><button>Salvar e entrar</button></form>' + msgHtml(msg));
      var f = el.querySelector('form');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        if (f.s.value !== f.s2.value) { novaSenha('As duas senhas não são iguais.'); return; }
        var u = f.u.value.trim().toLowerCase();
        ocupado(f, 'Salvando…');
        sb.rpc('definir_usuario', { p_usuario: u }).then(function (r) {
          if (r.error || !r.data) { novaSenha('Esse usuário já existe ou não vale (use 3 a 30 letras, números, ponto ou traço).'); return; }
          return sb.auth.updateUser({ password: f.s.value }).then(function (r2) {
            if (r2.error) { novaSenha(traduz(r2.error.message)); return; }
            recuperando = false; entrou();
          });
        });
      });
    });
  }

  function meuPerfil() {
    return sb.auth.getUser().then(function (r) {
      if (!r.data.user) return null;
      return sb.from('perfis').select('usuario,nome,status,email').eq('user_id', r.data.user.id).maybeSingle().then(function (x) { return x.data; });
    });
  }

  function sair() { sb.auth.signOut().then(function () { location.replace(aqui); }); }
  window.painelSair = sair;

  function entrou() {
    sb.rpc('tem_acesso').then(function (r) {
      if (r.error) { entrar('O banco ainda não foi preparado: falta rodar o acessos.sql no Supabase.'); return; }
      if (!r.data) {
        meuPerfil().then(function (p) {
          var recusado = p && p.status === 'recusado';
          tela('<h1>' + (recusado ? 'Acesso não liberado' : 'Pedido enviado') + '</h1>' +
            '<p>' + (recusado ? 'O Pedro não liberou o acesso desta conta ao painel.' : 'A sua conta foi criada. O Pedro já recebeu o pedido; você entra no painel assim que ele aprovar.') + '</p>' +
            '<p class="pl-links"><a href="#" data-ir="sair">Sair</a></p>');
        });
        return;
      }
      fecharTela(); ligarAoVivo(); liberar(true);
      sb.rpc('e_dono').then(function (d) { barra(!!d.data); });
    });
  }

  // a barra do canto: "Acessos" (só o Pedro) e "Sair"
  function barra(dono) {
    var b = document.createElement('div');
    b.id = 'ponte-barra';
    b.innerHTML = (dono ? '<button type="button" data-acessos>Acessos<span hidden></span></button>' : '') + '<button type="button" data-sair>Sair</button>';
    document.body.appendChild(b);
    b.querySelector('[data-sair]').addEventListener('click', sair);
    if (!dono) return;
    b.querySelector('[data-acessos]').addEventListener('click', abrirAcessos);
    contarPedidos();
    setInterval(contarPedidos, 60000);
  }
  function contarPedidos() {
    sb.from('perfis').select('user_id', { count: 'exact', head: true }).eq('status', 'pendente').then(function (r) {
      var s = document.querySelector('#ponte-barra [data-acessos] span');
      if (!s) return;
      s.hidden = !r.count; s.textContent = r.count || '';
    });
  }
  var ROTULO = { pendente: 'Esperando você', aprovado: 'Com acesso', recusado: 'Recusado' };
  function abrirAcessos(msg) {
    sb.from('perfis').select('user_id,nome,usuario,email,status,criado').order('criado', { ascending: false }).then(function (r) {
      sb.auth.getUser().then(function (eu) {
        var meu = eu.data.user && eu.data.user.id;
        var lista = (r.data || []).filter(function (p) { return p.user_id !== meu; });
        var linhas = lista.length ? lista.map(function (p) {
          var bts = p.status === 'aprovado' ? '<button type="button" class="pl-sec" data-dec="recusado" data-uid="' + p.user_id + '">Tirar o acesso</button>'
            : '<button type="button" data-dec="aprovado" data-uid="' + p.user_id + '">Aprovar</button>' +
              (p.status === 'pendente' ? '<button type="button" class="pl-sec" data-dec="recusado" data-uid="' + p.user_id + '">Recusar</button>' : '');
          return '<li><div><b>' + esc(p.nome || p.email) + '</b> <span class="pl-st pl-' + p.status + '">' + ROTULO[p.status] + '</span><br>' +
            '<small>' + esc(p.usuario ? '@' + p.usuario + ' · ' : '') + esc(p.email) + ' · ' + new Date(p.criado).toLocaleDateString('pt-BR') + '</small></div><div class="pl-bts">' + bts + '</div></li>';
        }).join('') : '<li><small>Ninguém pediu acesso ainda.</small></li>';
        var el = document.getElementById('ponte-acessos');
        if (!el) { el = document.createElement('div'); el.id = 'ponte-acessos'; document.body.appendChild(el); }
        el.innerHTML = '<div class="pl-card"><div class="pl-topo"><h1>Acessos</h1><button type="button" class="pl-sec" data-fechar>Fechar</button></div>' +
          '<p>Quem cria conta não vê nada até você aprovar. Quem você aprova vê e mexe em todo o painel, como você.</p>' +
          (typeof msg === 'string' ? msgHtml(msg) : '') + '<ul>' + linhas + '</ul></div>';
        el.querySelector('[data-fechar]').addEventListener('click', function () { el.remove(); });
        el.querySelectorAll('[data-dec]').forEach(function (bt) {
          bt.addEventListener('click', function () {
            bt.disabled = true;
            sb.rpc('decidir_acesso', { p_user: bt.getAttribute('data-uid'), p_status: bt.getAttribute('data-dec') }).then(function (x) {
              abrirAcessos(x.error || !x.data ? 'Não deu para salvar. Tente de novo.' : null); contarPedidos();
            });
          });
        });
      });
    });
  }

  // o link do e-mail "esqueci a senha" chega com type=recovery no endereço
  var recuperando = /type=recovery/.test(hashInicial);
  var jaEntrou = false;
  sb.auth.onAuthStateChange(function (ev, sessao) {
    if (ev === 'PASSWORD_RECOVERY') { recuperando = true; quandoPronto(function () { novaSenha(); }); return; }
    if (ev === 'SIGNED_OUT') { jaEntrou = false; return; }
    if (sessao && !jaEntrou && !recuperando) { jaEntrou = true; quandoPronto(entrou); }
  });
  sb.auth.getSession().then(function (r) {
    quandoPronto(function () {
      if (!r.data.session) entrar();
      else if (recuperando) novaSenha();
    });
  });

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
