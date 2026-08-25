---
id: 16
title: Gate de viabilidad del inspector HTTP — proxy + user CA en el build QA
label: wayfinder:task
status: open
assignee:
blocked-by: []
---

## Question

Antes de construir el inspector HTTP hay que confirmar en el device real que
`com.sample.oda.qa` (build Unity) es interceptable. Es el riesgo #1: si el build no
respeta el proxy del sistema o no confía en un user CA, no se ve ningún payload.

Con el device enchufado y el build QA instalado, verificar:

1. **Proxy del sistema:** setear proxy global por adb
   (`adb shell settings put global http_proxy <host>:<port>`) apuntando a una máquina con
   mitmproxy/Charles corriendo, abrir la app y ver si el tráfico HTTP(S) aparece en el
   proxy. OJO Unity: `UnityWebRequest`/BestHTTP a veces IGNORAN el proxy del sistema —
   este es el punto que puede matar el enfoque. Anotar qué stack de red usa sample.
2. **User CA:** instalar el cert del proxy como user CA y confirmar que el build lo acepta
   (requiere que el APK QA tenga un `network_security_config` que confíe en user CAs —
   verificar/pedir que el build QA lo tenga; en Play Store no aplica).
3. **Pinning:** confirmar que el build QA NO pinnea certs (o que se puede desactivar para
   QA). Si pinnea, documentar el costo (Frida + root, o build sin pinning).

Entregable: nota en el ticket con el veredicto por-mecanismo (proxy sí/no, user CA sí/no,
pinning sí/no) y, si algún eslabón falla, qué hay que cambiar en el build QA de sample.
Task manual-asistida: el agente prepara el script/instrucciones; el humano tiene el device
y coordina el cambio de build si hace falta.

Depende del device real → queda abierto hasta entonces (como el ticket 001).
