# OrquestAI

Escritorio personal de IA para Ingeniería Civil Informática. Se ejecuta en tu equipo como una aplicación local que abres en el navegador.

> **Estado: Fase 1 (núcleo funcional).** Ya funciona el chat con proveedores reales y simulados, con persistencia local. Los agentes, la orquestación multiagente, los presupuestos y la recuperación de tareas llegan en las fases siguientes (ver [Hoja de ruta](#hoja-de-ruta)).
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

### OpenCode Zen (Big Pickle)

Big Pickle no está en OpenRouter: lo ofrece **OpenCode Zen** (https://opencode.ai/docs/zen/).

1. Inicia sesión en la consola de OpenCode y copia tu clave API.
2. Escríbela en `.env`: `OPENCODE_ZEN_API_KEY=...`
3. En la app, acepta el aviso de OpenCode Zen y elige **Big Pickle**.

Según la documentación de OpenCode (consultada el 14-10-2026), Big Pickle es **gratuito por tiempo limitado** y, **durante ese periodo, los datos enviados pueden usarse para mejorar el modelo**. No envíes información sensible con este modelo.

## Política de costes en esta versión

Modo activo: **A · exclusivamente gratuito**. Antes de cada envío, el servidor comprueba que el modelo esté clasificado como gratuito. Bloquea los modelos de pago y los que no tienen un coste verificable, aunque la interfaz intente usarlos. Los modelos de pago, con presupuestos y autorización explícita, se habilitan en la Fase 3.

Cada respuesta muestra el uso de tokens y el coste distinguiendo entre **coste reportado** (lo informó el proveedor), **coste estimado** y **coste desconocido**.

## Seguridad y privacidad

- El servidor escucha solo en `127.0.0.1` y no es accesible desde la red.
- Valida las cabeceras `Host` y `Origin`, y cada petición a la API necesita un token aleatorio que se genera en cada arranque. Así otras páginas abiertas en tu navegador no pueden usar la API local.
- Las claves se ocultan en los registros y en los mensajes de error.
- Antes de enviar contenido a un proveedor externo por primera vez, la app pide aceptar un aviso.
- **Ajustes → Eliminar todos los datos locales** borra conversaciones, mensajes y ajustes.

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

## Estructura

```
src/
├── server/
│   ├── app.ts            Rutas de la API (Hono)
│   ├── main.ts           Arranque del servidor
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
| 1 | Núcleo: interfaz, servidor local, SQLite, proveedores, chat, errores, pruebas | **Implementada, pendiente de tu verificación** |
| 2 | Agentes y orquestación multiagente | Pendiente |
| 3 | Modelos de pago, presupuestos y escalamiento | Pendiente |
| 4 | Transferencia y recuperación de tareas | Pendiente |
| 5 | Seguridad, pruebas de integración y documentación completa | Pendiente |
| 6 | Estabilización | Pendiente |

## Limitaciones conocidas (Fase 1)

- No hay instalador; se requiere Node.js y abrir la app en el navegador.
- Los adaptadores reales se probaron **solo con respuestas simuladas** en las pruebas automatizadas. La conexión real con OpenRouter y OpenCode Zen está pendiente de verificarse con tus claves.
- Aún no hay reintentos automáticos ni modelos de respaldo (Fase 4); los errores se muestran con la acción recomendada.
- La salida estructurada (JSON) de los modelos se marca como «desconocida» hasta verificarla (Fase 2).
- El adaptador de Gemini API directo queda para una fase posterior; hoy los modelos Gemini se pueden usar a través de OpenRouter.
- Las respuestas se muestran como texto plano (sin formato Markdown).
- Si cierras la app mientras se genera una respuesta, al reiniciar esa respuesta queda como «Detenida» con el texto que se alcanzó a guardar (se guarda cada segundo).
- Proyectos, Agentes y Tareas aparecen en la barra lateral como «Próximamente» y están deshabilitados.
