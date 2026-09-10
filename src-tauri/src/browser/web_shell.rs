//! SSH「网页访问」的原生 webview 壳(固定走 wry 真实内核,不再走 Obscura)。
//!
//! 经 `starhub-web://localhost/<sessionId>/index.html?port=<网关端口>` 打开一个
//! 自包含窗口:顶部地址栏 + 全视口 iframe 加载
//! `http://127.0.0.1:<port>/__proxy__/<scheme>/<hostport><path>`。地址栏输入原始
//! URL 即重写为网关代理 URL(与前端 web-browser-utils 同形态),页面内根相对跳转
//! 由网关 `<base>`/改写处理。仅做壳页直出,不依赖 Obscura 引擎/直播帧。

use std::borrow::Cow;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 校验 sessionId(允许小写字母/数字/冒号/连字符,防路径穿越)。
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

/// `starhub-web://localhost/<sessionId>/<resource>` 协议处理器:只直出壳页。
pub fn web_shell_protocol_handler(
    _app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_string();
    let segments: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() != 2 || !valid_key(segments[0]) {
        return http_response(404, "text/plain; charset=utf-8", b"bad request".to_vec());
    }
    let (key, resource) = (segments[0], segments[1]);
    if matches!(resource, "index.html") || resource.is_empty() {
        let page = shell_page(key);
        http_response(200, "text/html; charset=utf-8", page.into_bytes())
    } else {
        http_response(404, "text/plain; charset=utf-8", b"not found".to_vec())
    }
}

fn http_response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Cow::Owned(body))
        .expect("构建 web-shell 响应失败")
}

/// 生成壳页(把 `__SESSION_KEY__` 替换为实际 sessionId)。
fn shell_page(session_id: &str) -> String {
    SHELL_PAGE.replace("__SESSION_KEY__", session_id)
}

/// 壳页:地址栏 + 全视口 iframe,原始 URL ↔ 网关代理 URL 双向改写,并消费网关
/// 注入桥接脚本的消息(右键菜单 / _blank 点击 / 导航上报)。
/// 与前端 `web-browser-utils.ts` 的代理形态一致:
/// `http://127.0.0.1:{port}/__proxy__/{scheme}/{hostport}{pathQuery}`。
///
/// 后退/前进必须经桥接的 `cmd-back` / `cmd-forward` 转发进 iframe:被代理页面
/// 与壳页跨源(starhub-web:// vs http://127.0.0.1:port),壳页直接访问
/// `frame.contentWindow.history` 会抛 SecurityError 被 try/catch 吞掉——
/// 即按钮点了没反应。刷新同理走 `cmd-reload`。
const SHELL_PAGE: &str = r##"
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 *{box-sizing:border-box}
 html,body{height:100%;margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#1e1f24;color:#e6e6e6}
 #bar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #333;background:#24262b}
 #bar button{height:28px;min-width:28px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border:1px solid #4a4d55;background:#33363c;color:#e6e6e6;border-radius:5px;cursor:pointer;font-size:14px}
 #bar button:hover{background:#40434b}
 #b{content:""}
 #addr{flex:1;height:28px;padding:0 10px;border:1px solid #4a4d55;border-radius:5px;background:#1a1b1f;color:#e6e6e6;outline:none}
 #frame{width:100%;height:calc(100% - 45px);border:0;background:#111}
 #ctx{position:fixed;z-index:99;min-width:180px;padding:4px;border:1px solid #4a4d55;border-radius:6px;background:#2b2e34;box-shadow:0 8px 24px rgba(0,0,0,.45)}
 #ctx button{display:block;width:100%;padding:6px 10px;border:0;border-radius:4px;background:transparent;color:#e6e6e6;font-size:12px;text-align:left;cursor:pointer}
 #ctx button:hover{background:#3a3e46}
 #ctx hr{margin:4px 6px;border:0;border-top:1px solid #454952}
</style></head>
<body>
<div id="bar">
  <button id="back" title="后退" aria-label="后退">&#8592;</button>
  <button id="fwd" title="前进" aria-label="前进">&#8594;</button>
  <button id="reload" title="刷新" aria-label="刷新">&#10227;</button>
  <input id="addr" placeholder="输入完整网址后按 Enter 访问" aria-label="地址栏">
</div>
<iframe id="frame" title="网页访问"></iframe>
<script>
var key='__SESSION_KEY__';
var port=parseInt(new URLSearchParams(location.search).get('port')||'0',10)||0;
var addr=document.getElementById('addr'),frame=document.getElementById('frame');
var gatewayOrigin=port>0?('http://127.0.0.1:'+port):null;
var lastUrl='';
function normalize(raw){
  raw=(raw||'').trim();
  if(!raw) return null;
  var candidate=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)?raw:('https://'+raw);
  var u; try{u=new URL(candidate);}catch(e){return null;}
  if(!u.hostname) return null;
  var scheme=u.protocol.replace(':','');
  var hs=u.hostname; var p=parseInt(u.port,10)||(scheme==='https'?443:80);
  if(p!==(scheme==='https'?443:80)) hs+=':'+p;
  var pq=u.pathname+(u.search||'')+(u.hash||'');
  if(pq==='') pq='/';
  return {scheme:scheme,hostport:hs,pathQuery:pq,href:u.href};
}
function proxyUrl(raw){
  var n=normalize(raw);
  if(!n||!port) return null;
  return 'http://127.0.0.1:'+port+'/__proxy__/'+n.scheme+'/'+n.hostport+n.pathQuery;
}
function originalOf(proxy){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/__proxy__\//.test(proxy||'')) return null;
  var rest=proxy.slice(proxy.indexOf('/__proxy__/')+'/__proxy__/'.length);
  var parts=rest.split('/');
  if(parts.length<2) return null;
  return parts[0]+'://'+parts[1]+'/'+parts.slice(2).join('/');
}
function setAddr(url){
  var o=originalOf(url);
  addr.value=o||url||'';
  if(o) lastUrl=o;
}
/* 向内层(被代理页面)下发桥接命令:跨源下壳页碰不到 iframe 的 history。 */
function sendToFrame(msg){
  if(!frame.contentWindow) return;
  try{frame.contentWindow.postMessage(Object.assign({__starhub:1},msg),'*');}catch(e){}
}
/* 复制文本:优先异步剪贴板,失败回退 execCommand 选区。 */
function copyText(text){
  if(!text) return;
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text);return;}
  }catch(e){}
  try{
    var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);
    ta.select();document.execCommand('copy');document.body.removeChild(ta);
  }catch(e){}
}
/* 在系统浏览器打开:仅在窗口拿到 Tauri IPC(能力已授权该窗口)时可用。 */
function canInvoke(){return typeof window.__TAURI_INTERNALS__!=='undefined'&&!!window.__TAURI_INTERNALS__.invoke;}
function openExternal(url){
  if(!canInvoke()) return false;
  try{window.__TAURI_INTERNALS__.invoke('open_external_url',{url:url});return true;}catch(e){return false;}
}
/* 右键菜单:桥接脚本在被代理页面内 preventDefault 后上报坐标,这里渲染替代菜单。 */
var ctx=document.createElement('div');
ctx.id='ctx';ctx.hidden=true;ctx.setAttribute('role','menu');document.body.appendChild(ctx);
function closeCtx(){ctx.hidden=true;}
function addItem(label,run){
  var b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');b.textContent=label;
  b.onclick=function(){closeCtx();run();};
  ctx.appendChild(b);
}
function openCtx(x,y,linkUrl){
  ctx.textContent='';
  addItem('后退',function(){sendToFrame({type:'cmd-back'});});
  addItem('前进',function(){sendToFrame({type:'cmd-forward'});});
  addItem('刷新',function(){sendToFrame({type:'cmd-reload'});});
  var sep=document.createElement('hr');ctx.appendChild(sep);
  addItem('复制页面链接',function(){copyText(lastUrl||addr.value);});
  if(linkUrl){
    addItem('复制链接地址',function(){copyText(linkUrl);});
    if(canInvoke()){
      addItem('在外部浏览器打开',function(){openExternal(linkUrl);});
    }else{
      addItem('在新页面打开链接',function(){var p=proxyUrl(linkUrl);if(p){frame.src=p;setAddr(p);}});
    }
  }
  ctx.hidden=false;
  var w=ctx.offsetWidth,h=ctx.offsetHeight;
  ctx.style.left=Math.max(4,Math.min(x,window.innerWidth-w-4))+'px';
  ctx.style.top=Math.max(4,Math.min(y,window.innerHeight-h-4))+'px';
}
document.addEventListener('mousedown',function(e){if(!ctx.hidden&&!ctx.contains(e.target))closeCtx();},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeCtx();});
window.addEventListener('resize',closeCtx);
addr.addEventListener('keydown',function(e){
  if(e.key!=='Enter') return;
  var raw=addr.value.trim();
  if(!raw) return;
  var p=proxyUrl(raw);
  if(p){frame.src=p; setAddr(p);} else {addr.value='';}
});
document.getElementById('back').onclick=function(){sendToFrame({type:'cmd-back'});};
document.getElementById('fwd').onclick=function(){sendToFrame({type:'cmd-forward'});};
document.getElementById('reload').onclick=function(){sendToFrame({type:'cmd-reload'});};
frame.addEventListener('load',function(){try{setAddr(frame.contentWindow.location.href);}catch(e){}});
/* 消费网关注入桥接脚本的消息:只接受来自本 iframe 且网关源的报文。 */
window.addEventListener('message',function(e){
  if(e.source!==frame.contentWindow) return;
  if(gatewayOrigin!==null&&e.origin!==gatewayOrigin) return;
  var d=e.data;
  if(!d||d.__starhub!==1) return;
  if(d.type==='navigated'){
    if(typeof d.href==='string') setAddr(d.href);
    return;
  }
  if(d.type==='contextmenu'){
    var link=(typeof d.link==='string'&&d.link)?d.link:'';
    openCtx(parseInt(d.x,10)||0,parseInt(d.y,10)||0,link);
    return;
  }
  if(d.type==='open-in-new-tab'&&typeof d.url==='string'&&d.url){
    /* 桥接拦下的 _blank / Ctrl 点击:能开外部浏览器就开,否则在壳内导航过去
       (此前这类点击被 preventDefault 后直接丢弃,表现为「点了链接没反应」)。 */
    if(openExternal(d.url)) return;
    var p=proxyUrl(d.url);
    if(p){frame.src=p;setAddr(p);}
  }
});
if(port>0){ addr.placeholder='输入内网网址后按 Enter 访问(如 http://a.internal:8080)'; }
else { addr.placeholder='Web 网关未启动,请先连接 SSH'; }
</script>
</body></html>
"##;

/// 打开 SSH 网页访问的 webview 壳窗口(固定 webview,不用 Obscura)。
/// `session_id` 用于窗口 label 去重与壳页 key;`gateway_port` 为 SSH web 网关端口。
pub async fn open_web_shell_window(
    app: &AppHandle,
    session_id: &str,
    asset_name: &str,
    gateway_port: u16,
) -> Result<(), String> {
    let label = format!("web-shell-{session_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| format!("聚焦网页访问窗口失败:{e}"))?;
        return Ok(());
    }
    let url = format!(
        "starhub-web://localhost/{session_id}/index.html?port={gateway_port}"
    );
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("网页访问 URL 非法:{e}"))?;
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(format!("{asset_name} · 网页访问"))
        .inner_size(1200.0, 820.0)
        .build()
        .map_err(|e| format!("创建网页访问窗口失败:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{shell_page, valid_key};

    #[test]
    fn valid_key_rejects_path_traversal_and_accepts_safe() {
        assert!(valid_key("abc-123"));
        assert!(valid_key("a:b"));
        assert!(!valid_key(".."));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("a%2fb"));
        assert!(!valid_key(""));
        assert!(!valid_key("A")); // 大小写混合拒绝
    }

    #[test]
    fn shell_page_consumes_bridge_messages() {
        let page = shell_page("ssh-1");
        // sessionId 注入到壳页 key
        assert!(page.contains("var key='ssh-1';"));
        // 消费网关注入桥接脚本的三类消息(此前壳页没有任何 message 消费者,
        // 页面内右键被 preventDefault 后毫无反应、_blank 点击被丢弃)
        assert!(page.contains("addEventListener('message'"));
        assert!(page.contains("'contextmenu'"));
        assert!(page.contains("'open-in-new-tab'"));
        assert!(page.contains("'navigated'"));
        // 只接受本 iframe + 网关源的报文
        assert!(page.contains("e.source!==frame.contentWindow"));
        assert!(page.contains("e.origin!==gatewayOrigin"));
        // 后退/前进/刷新经 cmd-* 下发进 iframe(跨源直取 history 会抛 SecurityError)
        assert!(page.contains("{type:'cmd-back'}"));
        assert!(page.contains("{type:'cmd-forward'}"));
        assert!(page.contains("{type:'cmd-reload'}"));
        // 右键替代菜单具备基本项与视口夹紧
        assert!(page.contains("openCtx"));
        assert!(page.contains("复制页面链接"));
        assert!(page.contains("在外部浏览器打开"));
    }
}

