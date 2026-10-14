# OrquestAI

Escritorio personal de IA para Ingeniería Civil Informática. Se ejecuta en tu equipo como una aplicación local que abres en el navegador.

> **Estado: Fase 2 completa (agentes y orquestación).** Funciona el chat con proveedores reales y simulados, con persistencia local. Puedes gestionar agentes, conversar con un agente concreto y crear tareas: el Coordinador las planifica, tú apruebas el plan y los agentes lo ejecutan con revisión crítica y síntesis. Los modelos de pago con presupuestos llegan en la Fase 3 y la recuperación automática de tareas en la Fase 4 (ver [Hoja de ruta](#hoja-de-ruta)).
>
> **No existe instalador de escritorio.** La aplicación necesita Node.js y se inicia con un comando.

## Requisitos

- Node.js **22 o superior** (`node -v` para comprobarlo).
- npm (viene con Node.js).
- Windows, macOS o Linux. La base de datos usa `better-sqlite3`, que descarga binarios precompilados para las plataformas habituales; si tu plataforma no los tiene, npm intentará compilarlo y necesitarás herramientas de compilación (en Windows, «Desktop development with C++» de Visual Studio Build Tools).

## Instalación y uso

```bash
git clone https://github.com/CitriCool/OrquestAI.git
cd OrquestAI
npm install
cp .env.example .env        # en Windows: copy .env.example .env
npm start
```

Abre **http://127.0.0.1:4317**. El proveedor «Simulado» funciona sin claves ni conexión, así que puedes probar la aplicación de inmediato.

| Comando | Qué hace |
|---|---|
| `npm start` | Compila la interfaz e inicia el servidor en http://127.0.0.1:4317 |
| `npm run serve` | Inicia el servidor sin recompilar la interfaz |
| `npm run dev` | Modo desarrollo con recarga automática; abre http://127.0.0.1:5173 |
| `npm test` | Ejecuta las pruebas automatizadas (no usan red ni claves reales) |
| `npm run typecheck` | Comprueba los tipos de TypeScript |

Para detener la aplicación, pulsa `Ctrl+C` en la terminal donde la iniciaste.

## Configurar proveedores

Las claves van **solo** en el archivo `.env`, que no se sube a git. Nunca se guardan en la base de datos ni se envían a la interfaz. Tras cambiar `.env`, reinicia la aplicación.

### OpenRouter

1. Crea una clave en https://openrouter.ai/keys.
2. Escríbela en `.env`: `OPENROUTER_API_KEY=sk-or-...`
3. En la app, ve a **Modelos y proveedores → OpenRouter**, acepta el aviso de envío de datos y pulsa **Ver modelos**.

La app clasifica como gratuitos los modelos cuyo precio de entrada y salida es 0 en el listado que entrega OpenRouter. Esa clasificación puede cambiar sin aviso, y algunos modelos gratuitos exigen activar opciones de privacidad en tu cuenta de OpenRouter.

### OpenCode Zen

1. Inicia sesión en la consola de OpenCode y copia tu clave API.
2. Escríbela en `.env`: `OPENCODE_ZEN_API_KEY=...`
3. En la app, acepta el aviso de OpenCode Zen y pulsa **Ver modelos**.

> **Big Pickle no se puede usar desde esta aplicación.** En la prueba real del 14-10-2026, la API de Zen respondió `403`: el nivel gratuito de OpenCode solo funciona desde el cliente oficial de OpenCode. La app lo muestra como «No disponible aquí», no lo ofrece en el selector y el servidor rechaza cualquier envío a ese modelo. Los demás modelos de Zen aparecen con coste desconocido, así que la política gratuita actual también los bloquea. Para usar modelos gratuitos desde OrquestAI, usa OpenRouter.

## Agentes

En **Agentes** encontrarás los 7 agentes iniciales del equipo: Coordinador, Desarrollador, Arquitecto de software, Revisor crítico, Especialista, Tutor y Sintetizador. Cada agente tiene:

- Identificador estable, nombre, descripción y rol.
- Instrucciones editables. Se envían como instrucciones de sistema, separadas de tus mensajes.
- Especialidad (en especialistas y agentes personalizados).
- Modelo preferido opcional. Al elegir el agente en un chat, se preselecciona si su proveedor está configurado.
- Modelo de respaldo opcional. Se guarda ahora y se usa en la Fase 4.
- Límite de tokens de salida y temperatura opcionales.
- Estado habilitado o deshabilitado.
- Historial de ejecuciones: cuántas respuestas generó y cuándo fue la última.

Puedes crear agentes **especialistas** o **personalizados** y eliminarlos. Los agentes iniciales no se eliminan, porque la orquestación los buscará por su rol, pero puedes editarlos, deshabilitarlos o **restaurar sus valores iniciales**.

Para conversar con un agente, pulsa **Conversar con este agente** o elige el agente en la cabecera de cualquier chat. «Asistente general» es el comportamiento sin agente. Al eliminar un agente personalizado, sus conversaciones se conservan como de asistente general.

## Tareas y planes

En **Tareas** describes un objetivo (y, si quieres, contexto, criterios de aceptación, nivel de revisión y complejidad). Después eliges el modelo y pulsas **Generar plan**. El **Coordinador** devuelve un plan en JSON que el servidor valida antes de guardarlo:

- Objetivo interpretado.
- Complejidad (nivel 1, 2 o 3) con su justificación.
- Criterios de aceptación verificables.
- Subtareas con agente asignado, dependencias y entrega esperada.
- Estrategia de revisión y condiciones de finalización.
- Supuestos y preguntas, si falta un dato esencial.

**Qué se valida.** El formato exacto, que los identificadores de las subtareas no se repitan, que las dependencias existan y no formen ciclos, y que cada subtarea use un agente habilitado. El Revisor crítico y el Sintetizador no reciben subtareas, porque la revisión y la síntesis son etapas fijas del flujo. Si la respuesta no es válida, el servidor pide **una** corrección con los errores concretos. Así una planificación hace como máximo 2 llamadas. Si tampoco sale bien, la tarea queda «Sin plan válido» y puedes ver los errores.

**Complejidad.** La aplicación también estima el nivel con reglas propias (palabras clave, extensión y número de criterios), sin depender solo del modelo. Ves las dos estimaciones y puedes fijar el **nivel definitivo**. De ese nivel salen los **límites de ejecución** (rondas y llamadas máximas), que fija el servidor y no el modelo.

**Aprobación.** El plan se guarda antes de ejecutar nada. Puedes aprobarlo o pedir una **nueva versión** con comentarios, por ejemplo para responder las preguntas del Coordinador. Cada versión queda en el historial. Si una versión nueva falla, el plan anterior sigue vigente. Cada llamada al modelo queda registrada con su estado, tokens y errores.

La planificación corre en segundo plano y puedes **detenerla**. Si cierras la aplicación a mitad de una planificación, al reiniciar la tarea vuelve a su plan vigente, o queda «Sin plan válido» si no tenía uno.

### Modelos gratuitos probados para planificar (14-10-2026)

| Modelo (OpenRouter) | Resultado |
|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | Plan válido en ~25 s. **Recomendado.** |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Plan válido y más detallado, en ~90 s. |
| `cohere/north-mini-code:free` | Gasta los tokens razonando y devuelve la respuesta vacía; no sirve para planificar. |
| `google/gemma-4-31b-it:free`, `poolside/laguna-s-2.1:free` | Límite de solicitudes (429) en la prueba. |
| `thinkingmachines/inkling:free` | OpenRouter lo restringe a ciertas aplicaciones (403). |

La disponibilidad de los modelos gratuitos cambia con frecuencia: es lo observado ese día, no una garantía. Para fijar el modelo del Coordinador, edita su **modelo preferido** en Agentes.

## Ejecución de tareas

Con el plan aprobado, pulsa **Ejecutar plan**. El flujo es secuencial y determinista, sin agentes que se llamen entre sí:

1. **Subtareas.** Se ejecutan en el orden que marcan sus dependencias. Cada agente recibe sus instrucciones, el objetivo, los criterios, su encargo y **solo** los resultados de las subtareas de las que depende, recortados si son largos. Cada resultado se guarda antes de pasar a la siguiente.
2. **Revisión crítica.** El Revisor evalúa cada criterio («cumple», «no cumple» o «no verificable») y devuelve observaciones en JSON validado: problema, gravedad, evidencia, criterio afectado, corrección sugerida, subtarea y estado. Si el formato no es válido, se le pide una corrección; si sigue mal, queda como limitación.
3. **Corrección.** Las observaciones pendientes de gravedad **alta** se devuelven al agente original de la subtarea. Con revisión **estricta**, también las de gravedad **media**. Después se revisa de nuevo, y en cada ronda el Revisor indica qué quedó corregido, pendiente o descartado (con justificación).
4. **Síntesis.** Si hay más de una subtarea, el Sintetizador integra todo con secciones fijas: solución, decisiones, resultado frente a los criterios, objeciones resueltas y pendientes, pruebas, y supuestos y limitaciones. Con una sola subtarea, la aplicación arma el resultado sin otra llamada.

**Control de rondas y llamadas.** El servidor aplica los límites del plan (rondas y llamadas máximas). Antes de cada ronda de corrección comprueba que queden llamadas para corregir, revisar y sintetizar. Si el Revisor repite las mismas observaciones sin información nueva, el proceso se detiene para no gastar llamadas.

**Resultado.** Puede ser **completo**, o **parcial con limitaciones**, por ejemplo si quedan observaciones sin corregir, se agotó el límite o una revisión no tuvo formato válido. Las limitaciones se muestran siempre. La aplicación **no ejecuta código**: las comprobaciones de los agentes son razonamiento del modelo y no una verificación objetiva, y así se indica en el resultado.

En la pantalla ves el **flujo** de la ejecución paso a paso (subtareas, revisiones con sus observaciones, correcciones y síntesis), con el modelo, los tokens y la entrega de cada paso. Puedes **detener** la ejecución en cualquier momento; la tarea queda «Interrumpida» con lo obtenido hasta entonces y puedes **ejecutarla de nuevo**. Al final puedes **aceptar el resultado**, **descargarlo** en Markdown o **copiarlo**.

Los agentes con **modelo preferido** usan el suyo. Los demás usan el modelo que elijas en la tarea. Antes de la primera llamada se comprueba que todos los modelos que se usarán estén permitidos.

**Fallos y respuestas cortadas.** Si falla una subtarea, la ejecución se detiene y la tarea queda «Falló la ejecución» con el error y las entregas anteriores guardadas. Si falla la revisión o la síntesis, se conserva el trabajo hecho y el resultado queda parcial, con el fallo explicado. Cuando una respuesta se corta por el límite de tokens de salida, se acepta pero se declara como limitación; si se corta la revisión, se le pide una versión más breve.

**Tiempos.** Cada llamada dentro de una tarea puede durar hasta `TASK_CALL_TIMEOUT_MS` (300 s por omisión), porque esas respuestas son largas; el chat usa `PROVIDER_TIMEOUT_MS` (120 s). Con modelos gratuitos, una tarea de 3 subtareas tarda unos 4 a 5 minutos.

## Política de costes en esta versión

Modo activo: **A · exclusivamente gratuito**. Antes de cada envío, el servidor comprueba que el modelo esté clasificado como gratuito. Bloquea los modelos de pago y los que no tienen un coste verificable, aunque la interfaz intente usarlos. Los modelos de pago, con presupuestos y autorización explícita, se habilitan en la Fase 3.

Cada respuesta muestra el uso de tokens y el coste distinguiendo entre **coste reportado** (lo informó el proveedor), **coste estimado** y **coste desconocido**.

## Seguridad y privacidad

- El servidor escucha solo en `127.0.0.1` y no es accesible desde la red.
- Valida las cabeceras `Host` y `Origin`, y cada petición a la API necesita un token aleatorio que se genera en cada arranque. Así otras páginas abiertas en tu navegador no pueden usar la API local.
- Las claves se ocultan en los registros y en los mensajes de error.
- Antes de enviar contenido a un proveedor externo por primera vez, la app pide aceptar un aviso.
- **Ajustes → Eliminar todos los datos locales** borra conversaciones, mensajes, ajustes y agentes personalizados, y devuelve los agentes iniciales a sus valores de fábrica.

Los datos se guardan en `./data/orquestai.db`. Puedes cambiar la ruta con `DATA_DIR` en `.env`.

## Probar sin claves

Con el proveedor **Simulado** puedes escribir estos comandos como mensaje:

| Mensaje | Simula |
|---|---|
| `/lento` | Una respuesta lenta, para probar **Detener** (la parte recibida se conserva) |
| `/error 429` | Límite de solicitudes, con espera indicada por el proveedor |
| `/error 500` | Error interno del proveedor |
| `/error 401` | Clave rechazada |
| `/error 403` | Acceso denegado |
| `/error 404` | Modelo no disponible |
| `/error timeout` | Tiempo agotado |
| `/error red` | Fallo de conexión |

En **Tareas**, el Simulado devuelve un plan de ejemplo. Si el objetivo incluye `/plan invalido`, nunca entrega un plan válido. Con `/plan reparable`, el primer intento falla y la corrección funciona.

Para probar la ejecución, escribe en el **contexto** de la tarea:

| Contexto | Simula |
|---|---|
| `/revision cambios` | La primera revisión pide un cambio importante; tras la corrección, aprueba |
| `/revision menor` | La revisión pide un cambio de gravedad media (solo se corrige con revisión estricta) |
| `/revision repetida` | La revisión repite siempre la misma observación (detención por falta de avance) |
| `/revision invalida` | La revisión nunca tiene formato válido |
| `/ejecucion error` | Las subtareas fallan con un error del proveedor |
| `/ejecucion lenta` | Las subtareas responden lento, para probar **Detener** |

## Estructura

```
src/
├── server/
│   ├── app.ts            Rutas de la API (Hono)
│   ├── main.ts           Arranque del servidor
│   ├── agents/           Agentes iniciales del equipo
│   ├── tasks/            Planificación, ejecución (subtareas, revisión, corrección, síntesis) y reglas de complejidad
│   ├── chat/             Servicio de conversación y contexto por llamada
│   ├── providers/        Contrato común, errores, adaptadores (simulado, compatible con OpenAI)
│   ├── policies/         Política de modelos permitidos
│   ├── security/         Guardián local y redacción de secretos
│   └── storage/          SQLite, migraciones y repositorio
├── client/               Interfaz (Preact + Vite)
└── shared/               Esquemas (Zod) y límites compartidos
tests/
├── unit/
├── integration/
└── fixtures/
```

## Hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Análisis y diseño | Aprobada |
| 1 | Núcleo: interfaz, servidor local, SQLite, proveedores, chat, errores, pruebas | **Cerrada** (14-10-2026, verificada con OpenRouter real) |
| 2.1 | Gestión de agentes y chat con un agente | **Implementado** |
| 2.2 | Coordinador: tareas, planes en JSON validado y aprobación del plan | **Implementado** |
| 2.3 | Ejecución secuencial de subtareas, revisión crítica, síntesis y vista del flujo | **Implementado** |
| 3 | Modelos de pago, presupuestos y escalamiento | Pendiente |
| 4 | Transferencia y recuperación de tareas | Pendiente |
| 5 | Seguridad, pruebas de integración y documentación completa | Pendiente |
| 6 | Estabilización | Pendiente |

## Limitaciones conocidas

- No hay instalador; se requiere Node.js y abrir la app en el navegador.
- Las pruebas automatizadas usan respuestas simuladas. La conexión real se verificó a mano el 14-10-2026: OpenRouter funciona de punta a punta con modelos gratuitos (también con agentes), y OpenCode Zen lista sus modelos pero rechaza Big Pickle desde aplicaciones de terceros.
- El listado gratuito de OpenRouter incluye algunos modelos que no son de chat (por ejemplo, de música). Si eliges uno, el proveedor puede responder con error.
- La ejecución es solo secuencial; la ejecución en paralelo de subtareas independientes queda para más adelante.
- Si una ejecución se interrumpe o falla, se vuelve a ejecutar desde el principio. La reanudación desde el punto de corte y el cambio automático a un modelo de respaldo llegan en la Fase 4.
- Aún no se pueden pedir cambios sobre un resultado terminado. Puedes pedir una nueva versión del plan con comentarios y ejecutarla.
- El resultado se muestra como texto (el Markdown no se renderiza).
- Los planes no se editan a mano: se piden versiones nuevas con comentarios.
- La salida en JSON se pide en las instrucciones y se valida en el servidor; no se usa el modo JSON nativo de los proveedores porque su soporte varía según el modelo.
- Los modelos gratuitos suelen responder con límite de solicitudes (429). Aún no hay reintentos automáticos (Fase 4).
- Aún no hay reintentos automáticos ni modelos de respaldo (Fase 4); los errores se muestran con la acción recomendada.
- La salida estructurada (JSON) de los modelos se marca como «desconocida» hasta verificarla (Fase 2).
- El adaptador de Gemini API directo queda para una fase posterior; hoy los modelos Gemini se pueden usar a través de OpenRouter.
- Las respuestas se muestran como texto plano (sin formato Markdown).
- Si cierras la app mientras se genera una respuesta, al reiniciar esa respuesta queda como «Detenida» con el texto que se alcanzó a guardar (se guarda cada segundo).
- Proyectos y Tareas aparecen en la barra lateral como «Próximamente» y están deshabilitados.
