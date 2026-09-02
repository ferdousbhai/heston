import { DEPLOYMENT_RELOAD_COOLDOWN_MS } from './data/deployment'

/** Long enough that a slow first paint is never mistaken for a build that cannot load. */
export const BOOT_RECOVERY_DELAY_MS = 10_000

export const BOOT_RECOVERY_STORAGE_KEY = 'spice.boot-recovery.v1'

/**
 * The body is empty until the app hydrates, so anything that stops the entry module from
 * running leaves a blank page and no code of ours to notice. A shell held by an obsolete
 * service worker does exactly that: it names hashed files that no longer exist, every one
 * 404s, and nothing runs.
 *
 * This is deliberately inline, dependency-free, and ES5: it has to survive in a document
 * whose modules never loaded. If nothing has reported hydration by the deadline, it drops
 * the caches and workers that could be pinning the reader to a dead build, and reloads.
 *
 * The attempt is recorded in session storage so a genuinely broken deploy cannot loop, and
 * it expires on the same cooldown the deployment reload uses: iOS restores tabs across app
 * restarts, so session storage there is effectively permanent, and a latch that never expired
 * would turn one failed attempt into a tab that never tries again. Storage that cannot be read
 * cannot bound a loop either, so it counts as an attempt in progress.
 */
export function bootRecoveryScript(
  delayMs: number = BOOT_RECOVERY_DELAY_MS,
  cooldownMs: number = DEPLOYMENT_RELOAD_COOLDOWN_MS,
): string {
  return `(function(){
  var KEY='${BOOT_RECOVERY_STORAGE_KEY}';
  var COOLDOWN=${cooldownMs};
  function attemptedAt(){ try { return Number(sessionStorage.getItem(KEY)) } catch (error) { return Infinity } }
  function remember(){ try { sessionStorage.setItem(KEY, String(Date.now())) } catch (error) {} }
  window.__spiceBooted=function(){ clearTimeout(timer); try { sessionStorage.removeItem(KEY) } catch (error) {} };
  var timer=setTimeout(function(){
    var at=attemptedAt();
    if (at > 0 && Date.now() - at < COOLDOWN) return;
    remember();
    var reload=function(){ location.reload() };
    var work=[];
    if (navigator.serviceWorker) work.push(navigator.serviceWorker.getRegistrations().then(function(all){
      return Promise.all(all.map(function(one){ return one.unregister() }));
    }));
    if (window.caches) work.push(caches.keys().then(function(names){
      return Promise.all(names.map(function(name){ return caches.delete(name) }));
    }));
    Promise.all(work).then(reload, reload);
  }, ${delayMs});
})()`
}
