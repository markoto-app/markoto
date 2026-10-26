---
slug: privacy
locale: es
version: 6
effectiveDate: 2026-10-26
translationStatus: machine-translated
---

# Política de privacidad

> **En resumen:** markoto almacena los documentos que escribe, los comentarios que deja y lo mínimo que necesitamos para gestionar su cuenta. El servicio es actualmente gratuito; todavía no se ofrecen planes de pago. Las funciones de IA se ejecutan en proveedores radicados en la UE (Mistral AI para texto y voz, Jina AI para embeddings y obtención de páginas individuales, Staan para la búsqueda web, Black Forest Labs para la generación de imágenes), salvo que conecte su propio proveedor de IA, en cuyo caso su contenido de IA se envía al proveedor que haya elegido. No vendemos sus datos, no mostramos publicidad y no entrenamos IA con su contenido. Puede exportar los datos que tenemos sobre usted y eliminar su cuenta en cualquier momento desde sus ajustes.

---

## 1. Quiénes somos

markoto está operado por **{{controllerName}}** ({{controllerAddress}}). Para cualquier consulta sobre privacidad, escriba a **{{privacyContactEmail}}**.

A los efectos del Reglamento general de protección de datos (Reglamento (UE) 2016/679, «RGPD»), markoto es el **responsable del tratamiento** de los datos personales que usted proporciona directamente (su cuenta y, si se apunta, la lista de espera de planes de pago). Cuando usa markoto dentro de un espacio de trabajo propiedad de un tercero, el propietario de ese espacio es el responsable del tratamiento de cualquier contenido que usted incorpore a él, y markoto actúa como **encargado del tratamiento** en virtud de una Adenda de tratamiento de datos (véase `/legal/dpa`).

## 2. Qué datos tratamos y por qué

Seguimos el principio de minimización de datos: recogemos la menor cantidad de datos necesaria para cada fin y le explicamos cuál es ese fin.

La tabla completa de fines del tratamiento —con la base jurídica, las categorías de datos, el plazo de conservación y los subencargados implicados— se recoge en el registro del apartado 13 más abajo, generado a partir de nuestro registro interno. Cualquier cambio en este registro se considera una modificación sustancial de esta política y hace avanzar el número de versión (véase el apartado 14).

## 3. Base jurídica (artículo 6 del RGPD)

Cada tratamiento se basa en una de las siguientes bases jurídicas:

- **Contrato** (artículo 6, apartado 1, letra b) — para todo lo necesario para prestar el servicio al que se registró: creación de cuenta, almacenamiento de documentos, asistencia de IA y, cuando se ofrezcan planes de pago, facturación.
- **Obligación legal** (artículo 6, apartado 1, letra c) — para el registro de auditoría de seguridad y, cuando se ofrezcan planes de pago, las obligaciones de conservación del Derecho fiscal (datos de facturación).
- **Interés legítimo** (artículo 6, apartado 1, letra f) — para la prevención del fraude y el abuso, la supervisión de errores y la telemetría de seguridad. Puede oponerse al tratamiento basado en este fundamento (véase el apartado 6).
- **Consentimiento** (artículo 6, apartado 1, letra a) — para la analítica de producto y la grabación de sesiones (nunca las cargamos salvo que haya dado su consentimiento en el banner de cookies) y para la lista de espera de planes de pago (solo si marca la casilla de consentimiento al apuntarse y después confirma el correo que le enviamos). Puede retirarlo en cualquier momento.

## 4. Subencargados y transferencias internacionales

Utilizamos una breve lista de subencargados, todos vinculados por contratos conforme al artículo 28 del RGPD. La lista vigente está en `/legal/sub-processors`. Esa lista muestra únicamente los proveedores que este despliegue usa realmente: por ejemplo, Stripe (procesamiento de pagos) solo aparece cuando se activan los planes de pago, y un proveedor de IA que **usted** conecte por su cuenta (véase el apartado 8) no es nuestro subencargado y no figura en ella.

Cuando un subencargado trata datos fuera del Espacio Económico Europeo, nos basamos en:

- la decisión de adecuación del **Marco de Privacidad de Datos UE-EE. UU.** (Data Privacy Framework, 10 de julio de 2023) para los destinatarios con sede en EE. UU. certificados en el DPF, Y
- las **cláusulas contractuales tipo** (2021/914) con carácter subsidiario, por si se invalidara la decisión de adecuación del DPF.

Notificamos a los clientes propietarios de espacios de trabajo con al menos 30 días de antelación cualquier nuevo subencargado.

## 5. Ubicación del almacenamiento y conservación

Los datos de la aplicación y los documentos se alojan en la base de datos PostgreSQL gestionada y el almacenamiento de objetos de OVHcloud, en la Unión Europea (Francia). El tratamiento relacionado con la IA lo realizan proveedores radicados en la UE —Mistral AI (Francia), Jina AI (Alemania), Staan (UE) y Black Forest Labs (región de la UE fijada)— a través de nuestro proxy LiteLLM autoalojado. Mientras el servicio sea gratuito no tratamos datos de pago; cuando se ofrezcan planes de pago, los datos de facturación los conservará Stripe. La telemetría de errores de la aplicación la trata Sentry en su región de la UE (Fráncfort). Los correos transaccionales (confirmaciones de eliminación, avisos de exportación de datos lista, notificaciones de violaciones de seguridad) se envían a través de Resend; solo la dirección del destinatario, el asunto y el cuerpo del mensaje transitan por los sistemas de Resend, que los conserva 30 días para supervisar la entregabilidad.

La conservación sigue el calendario por fin recogido en el registro del apartado 13. Como regla general:

- **Los datos de cuenta** se conservan hasta que solicite su eliminación.
- **Los documentos y contenidos** se conservan hasta que los elimine o elimine su cuenta.
- **Los documentos anónimos** (creados sin iniciar sesión y que no forman parte de un espacio de trabajo) se eliminan automáticamente tras 180 días sin actividad en el servicio alojado. Los despliegues autoalojados pueden configurar otro plazo o desactivar esta limpieza. Los documentos que pertenecen a una cuenta y los de espacios de trabajo no se eliminan automáticamente.
- **Los registros de solicitudes a la IA y llamadas a herramientas** se conservan 90 días para la revisión de abusos y después se eliminan.
- **Los registros de auditoría** se conservan durante el tiempo necesario para fines de seguridad y jurídicos. Cuando elimina su cuenta, se retira de ellos su identificador de cuenta (véase el apartado 5b).
- **Los datos de facturación** no existen mientras el servicio sea gratuito. Cuando se ofrezcan planes de pago, se conservarán durante el mínimo legal impuesto por el Derecho fiscal de la UE y de los Estados miembros (normalmente de 7 a 10 años).
- **Los metadatos de los correos transaccionales** (destinatario, hora de envío, estado de entrega) los conserva Resend 30 días; no almacenamos el cuerpo de los correos tras la entrega.
- **Lista de espera de planes de pago.** Si se apunta a la lista de espera en la página de precios, almacenamos su dirección de correo electrónico, el idioma con el que se apuntó, la versión del texto de consentimiento que aceptó, cuándo se apuntó y confirmó y, si había iniciado sesión, un vínculo con su cuenta. No almacenamos su dirección IP. Lo usamos únicamente para avisarle cuando se lancen los planes de pago. Su inscripción solo cuenta tras hacer clic en el enlace de confirmación que le enviamos por correo (doble confirmación); las inscripciones sin confirmar se eliminan a los 7 días. Cada correo incluye un enlace de baja que elimina su inscripción de inmediato; en caso contrario, eliminamos la lista como máximo 3 meses después de enviar el anuncio del lanzamiento. Al eliminar su cuenta también se elimina una inscripción vinculada, y su exportación de datos la incluye. El correo de confirmación se envía a través de Resend; la lista en sí se almacena en la base de datos PostgreSQL gestionada de OVHcloud en la UE.

## 5b. Qué ocurre cuando elimina su cuenta

Queremos ser totalmente transparentes sobre lo que implica la eliminación. El botón de `/settings/profile` programa la eliminación permanente de su cuenta **dentro de 30 días**. Durante ese periodo de gracia su cuenta sigue siendo utilizable; puede cancelar desde cualquier página que muestre el banner de eliminación. Transcurridos los 30 días, lo siguiente se ejecuta automáticamente: sin más confirmación y sin posibilidad de recuperar nada.

### Qué se elimina de forma permanente

- **El registro de su cuenta** — nombre, correo electrónico, identificadores OAuth, preferencias, idioma, confirmación de edad, versiones de las políticas aceptadas.
- **Todos los documentos de su propiedad** — incluidos los que haya compartido con colaboradores en modo de edición. Los colaboradores pierden el acceso a esos documentos al mismo tiempo. *Si quiere que los colaboradores conserven un documento, transfiérales su propiedad o duplíquelo en su cuenta antes de solicitar la eliminación.*
- **Todos los temas guardados** de su cuenta.
- **Todos los espacios de trabajo en los que usted es el único miembro**, y todos los documentos y archivos de conocimiento que contienen. *Si quiere conservar el contenido de un espacio de trabajo, invite antes a otro miembro de eliminar su cuenta, o descargue los documentos previamente con la función de exportación de datos de `/settings/profile`.*
- **Su uso de la IA** — solicitudes pasadas (las conservamos de forma privada 90 días para la revisión de abusos), sesiones de IA abiertas y los ajustes de un proveedor de IA propio (traiga su propia clave) con sus claves de API cifradas (véase el apartado 8).
- **Sus trabajos de exportación de datos** y los archivos ZIP que hubiéramos preparado para usted.
- **Su registro de cliente en Stripe, si existe** (solo posible cuando se ofrezcan planes de pago) — indicamos a Stripe que lo elimine. Stripe conserva los registros de facturas y pagos subyacentes durante el periodo que exija la normativa fiscal (normalmente de 7 a 10 años), con independencia de nuestra solicitud.

### Qué se anonimiza: se conserva en la plataforma sin su nombre

- **Los comentarios que escribió en documentos que no son de su propiedad** — el texto permanece para que la conversación siga siendo comprensible para los demás participantes, pero su nombre y el vínculo con su cuenta se sustituyen por `[usuario eliminado]`.
- **Las entradas del registro de auditoría** — conservamos nuestro registro de seguridad interno sin su identificador de cuenta pero con la acción correspondiente. Base jurídica: interés legítimo en la prevención del fraude + obligación legal. La conservación sigue nuestra política habitual de registro de auditoría.
- **Las entradas del registro de actividad** — sus ediciones, restauraciones y cambios de tema en documentos que NO son suyos permanecen en el historial de actividad del documento como «Anónimo». Las ediciones en documentos propios desaparecen con el documento.
- **Las entradas del registro de consentimiento** — anonimizamos el vínculo con el usuario pero conservamos el registro histórico para poder demostrar que se dio el consentimiento (exigencia del artículo 7, apartado 1, del RGPD).

### Qué ocurre con los espacios de trabajo en los que es administrador junto con otras personas

Si es administrador de un espacio de trabajo que, cuando se elimine su cuenta, tenga al menos otro miembro, **promovemos automáticamente a administrador a uno de los miembros restantes**: el miembro más antiguo, prefiriendo a un administrador existente, después a un editor y después a un lector. El espacio de trabajo y su contenido se conservan para los miembros restantes. El nuevo administrador recibe un aviso tras la promoción.

El campo de procedencia «propietario» del espacio de trabajo se reasigna al nuevo administrador para que las claves foráneas queden limpias. La autorización siempre se ha basado en el rol de miembro, no en el campo de propietario, por lo que se trata de una simple cuestión contable.

### Espacios de trabajo que conviene limpiar manualmente antes

Como la eliminación en cascada de un espacio de trabajo suprime también contenido de otros miembros cuando usted era la única persona, le recomendamos encarecidamente hacer lo siguiente antes de solicitar la eliminación de su cuenta si quiere asegurarse de que se conserve el trabajo de los demás:

- En cualquier espacio de trabajo del que sea el único miembro pero cuyo contenido quiera conservar: invite primero al menos a un colaborador con rol de administrador, que heredará el espacio.
- En cualquier documento que quiera que conserve un colaborador: transfiérale la propiedad (muévalo fuera de su espacio de trabajo a uno que sea suyo, O duplíquelo en su cuenta) o pídale que descargue antes una copia.
- En los archivos de la base de conocimiento que quiera preservar: descárguelos fuera de markoto, ya que se eliminan con el espacio de trabajo.

### Su exportación de datos

Antes de solicitar la eliminación de su cuenta, puede usar la función de **exportación de datos** en `/settings/profile` para recibir un archivo ZIP con todo lo que tenemos sobre usted: documentos en markdown, comentarios que haya escrito, pertenencia a espacios de trabajo, registros de uso de la IA, los ajustes de su proveedor de IA (URL del proveedor, modelo y función; nunca la clave de API), su inscripción en la lista de espera si la hay, sus decisiones de consentimiento y, cuando existan planes de pago, el historial de facturación. Es un flujo independiente que genera un archivo descargable que puede conservar pase lo que pase con su cuenta de markoto.

### Cuánto tarda realmente la cascada

Una tarea en segundo plano ejecuta la cascada una vez por hora. En el peor de los casos, sus datos se eliminan por completo aproximadamente una hora después de terminar el periodo de gracia de 30 días. Recibirá un correo de confirmación cuando se haya ejecutado la eliminación (siempre que haya una dirección de correo registrada).

### Cancelación

Hasta que se ejecute la cascada, puede cancelar la eliminación programada iniciando sesión y pulsando «Cancelar eliminación» en cualquier página (durante el periodo de gracia aparece un banner en la parte superior de la pantalla). Una vez ejecutada la cascada, su cuenta, sus sesiones y su contenido desaparecen: no hay forma de recuperarlos.

## 6. Sus derechos (artículos 15 a 22 del RGPD)

Tiene derecho a:

- **Acceder** a los datos personales que conservamos sobre usted (artículo 15): use la herramienta de exportación en `/settings/profile`.
- **Rectificar** los datos inexactos (artículo 16): edite su perfil o escríbanos.
- **Suprimir** sus datos («derecho al olvido», artículo 17): use la herramienta de eliminación en `/settings/profile`. Esperamos 30 días y después los eliminamos de forma permanente.
- **Limitar** el tratamiento (artículo 18): escríbanos.
- **Oponerse** al tratamiento basado en el interés legítimo (artículo 21): escríbanos.
- **Portabilidad de los datos** (artículo 20): la herramienta de exportación devuelve sus datos en JSON, NDJSON y Markdown legibles por máquina.
- **Retirar el consentimiento** (artículo 7, apartado 3) cuando el tratamiento se base en él: active o desactive el fin correspondiente en el banner de cookies (icono de privacidad del pie de página).
- **Presentar una reclamación** ante una autoridad de control (artículo 77): véase el apartado 11.

Respondemos a todas las solicitudes en 30 días. No cobramos por ellas, salvo en caso de solicitudes manifiestamente infundadas o excesivas.

## 7. Decisiones automatizadas

markoto no adopta decisiones que produzcan efectos jurídicos o le afecten significativamente de modo similar basándose únicamente en un tratamiento automatizado. El asistente de IA ofrece sugerencias que usted decide aceptar o rechazar: la autoría final siempre es suya. Cuando se ofrezcan planes de pago, Stripe realizará una puntuación de riesgo automatizada de los intentos de pago; si un intento se rechaza por este motivo, podrá solicitar una revisión humana escribiéndonos.

## 8. Funciones de IA y transparencia

markoto incluye un asistente de escritura con IA y un sistema de recuperación de la base de conocimiento. Las solicitudes de IA se encaminan a través de nuestro proxy LiteLLM autoalojado hacia proveedores radicados en la UE: Mistral AI (generación de texto, transcripción de voz con Voxtral), Jina AI (embeddings para la base de conocimiento, extracción del contenido de una URL individual), Staan (búsqueda web mediante un índice de búsqueda europeo propio, encaminamiento exclusivamente en la UE) y Black Forest Labs (generación de imágenes, región de la UE fijada). Las consultas de búsqueda web ya no transitan por buscadores estadounidenses. Se lo indicamos en la interfaz: cada mensaje asistido por IA lleva una insignia visible de «IA», y todo contenido generado por IA que se incluya en un documento público lleva un aviso de transparencia. Ninguno de estos proveedores utiliza el contenido de la API para entrenar sus modelos en los niveles que usamos.

### Su propio proveedor de IA (traiga su propia clave)

Puede conectar su propia cuenta de proveedor de IA (un servicio compatible con OpenAI de entre las opciones ofrecidas en los ajustes, por ejemplo Mistral AI u OpenAI; los despliegues autoalojados de markoto pueden permitir otros) en **Ajustes → Proveedor de IA**, por separado para chat, generación de imágenes y transcripción de voz. Cuando lo hace, el contenido necesario para esa función —su solicitud, el contexto pertinente del documento, las grabaciones de voz y el resultado generado— se envía a través de nuestro proxy LiteLLM a **el proveedor que usted eligió, en virtud de su propio acuerdo con ese proveedor**. markoto no elige ese proveedor y este no es uno de nuestros subencargados; sus condiciones y prácticas de protección de datos (incluido dónde trata los datos y si entrena con contenido de la API) son las de su contrato con él. Almacenamos los ajustes de su proveedor (URL del proveedor, nombre del modelo y su clave de API, cifrada en reposo) hasta que los elimine o elimine su cuenta; solo se le vuelven a mostrar los últimos cuatro caracteres de la clave, la clave nunca se incluye en su exportación de datos (la exportación contiene solo la URL del proveedor, el modelo y la función) y no la escribimos en los registros de nuestra aplicación. Los registros de solicitudes y llamadas a herramientas siguen la conservación de 90 días indicada arriba. Los embeddings siempre usan nuestro propio proveedor radicado en la UE enumerado arriba.

La búsqueda web y la obtención de páginas individuales las proporcionamos nosotros y funcionan igual si usa o no su propio proveedor de IA: la consulta de búsqueda que formula el asistente (hasta 400 caracteres, que puede derivarse de su solicitud o de su documento) se envía a Staan, y la dirección web que el asistente quiere leer se envía a Jina AI (Jina Reader), en ambos casos directamente desde nuestra aplicación (sin pasar por el proxy LiteLLM) y a través de nuestra propia cuenta con ese proveedor, no la suya. Staan y Jina AI son nuestros subencargados del tratamiento, enumerados arriba. Los resultados de búsqueda o el texto extraído de la página los resume después su proveedor de chat (su propio proveedor si conectó uno; si no, el nuestro), por lo que ese texto se le transmite. Para limitar costes y abusos, cada persona con sesión iniciada puede realizar un número limitado de búsquedas web y obtenciones de páginas por hora y por día (por defecto 30 por hora y 100 por día, compartidas entre el editor y los clientes MCP). Para aplicarlo conservamos en Valkey contadores asociados a su identificador de usuario interno, que solo contienen marcas de tiempo —ni consulta, ni dirección, ni contenido— y caducan automáticamente al terminar su ventana de tiempo. Estas herramientas solo están disponibles si el operador las ha configurado.

El uso de las funciones de IA requiere iniciar sesión. Son opcionales: el contenido de un documento solo se envía a un proveedor de IA cuando invoca al asistente o sube archivos a una base de conocimiento de un espacio de trabajo (que Jina AI convierte en embeddings).

## 9. Cookies y tecnologías similares

Usamos almacenamiento esencial (una cookie de sesión, una preferencia de idioma y su propia decisión de consentimiento) para mantener su sesión iniciada y recordar sus preferencias; esto no requiere consentimiento conforme a la Directiva ePrivacy. Solo usamos analítica de producto y grabación de sesiones con su consentimiento, que puede dar o retirar en cualquier momento desde el enlace «Opciones de privacidad» del pie de cada página.

No usamos rastreadores publicitarios entre sitios y no vendemos ni compartimos datos con anunciantes.

## 10. Menores

markoto no está dirigido a menores que no hayan alcanzado la edad de consentimiento digital de su país (16 años en la mayoría de los Estados miembros de la UE; menos en algunos). Si tiene conocimiento de que un menor ha creado una cuenta incumpliendo esta norma, comuníquelo a **{{privacyContactEmail}}**.

## 11. Derecho a presentar una reclamación

Si considera que no hemos respetado sus derechos, tiene derecho a presentar una reclamación ante una autoridad de control de protección de datos.

- **En la UE/EEE:** puede reclamar ante la autoridad de control de su país de residencia habitual, de su lugar de trabajo o del lugar de la presunta infracción. El Comité Europeo de Protección de Datos publica una lista de las autoridades de control de la UE/EEE. Como estamos establecidos en Suiza (fuera de la UE/EEE), no nos alcanza el mecanismo de «ventanilla única» del RGPD, por lo que no existe una única autoridad principal: puede dirigirse directamente a su autoridad local.
- **En Suiza:** la autoridad competente es el Comisionado Federal de Protección de Datos y Transparencia (PFPDT/EDÖB).

También nos gustaría tener la oportunidad de resolver primero su preocupación directamente: escríbanos a **{{privacyContactEmail}}**.

## 12. Seguridad

Protegemos los datos mediante cifrado en tránsito (TLS), cifrado en reposo en la capa de plataforma de OVHcloud, hash de contraseñas con scrypt y truncamiento de IP en los registros de auditoría. En caso de violación de la seguridad de los datos personales, nos comprometemos a notificarla a la autoridad de control competente en un plazo de 72 horas, conforme al artículo 33 del RGPD.

Si tenemos conocimiento de una violación de la seguridad de los datos personales que le afecte, la notificaremos a la autoridad de control en 72 horas y se lo comunicaremos a usted sin dilación indebida si la violación entraña un alto riesgo para sus derechos.

## 13. Registro de fines del tratamiento

La tabla siguiente se genera a partir de nuestro registro interno de fines del tratamiento y recoge únicamente lo que este despliegue hace realmente (por ejemplo, la facturación solo aparece cuando se activan los planes de pago). La tabla se mantiene en inglés.

{{processingPurposesTable}}

## 14. Cambios en esta política

Esta es la **versión {{currentVersion}}**, en vigor desde el **{{effectiveDate}}**. Los cambios sustanciales (nuevos fines del tratamiento, nuevos subencargados, cambios en la conservación) provocan un cambio de versión y una solicitud de nueva aceptación en el producto. Las versiones anteriores están disponibles previa solicitud a **{{privacyContactEmail}}**.

### Historial de cambios

- **v6 (2026-10-26), adaptación editorial al servicio exclusivamente gratuito.** Stripe y la facturación se describen como relevantes solo cuando se ofrezcan planes de pago (la lista de subencargados y el registro omiten Stripe mientras la facturación esté desactivada). El registro de fines del tratamiento ahora se muestra realmente en el apartado 13. Se corrigieron las afirmaciones sobre la conservación de los registros de auditoría, la limpieza de documentos anónimos (180 días de inactividad), el contador de interacciones retirado y la (inexistente) exclusión de la IA a nivel de cuenta.
- **v6 (2026-10-26).** Se añadió el fin de tratamiento `user_directed_ai_provider`: puede conectar su propio proveedor de IA (chat, generación de imágenes, transcripción de voz). El contenido de esas funciones se envía entonces al proveedor que elija, en virtud de su acuerdo con él; almacenamos los ajustes de su proveedor con la clave de API cifrada en reposo hasta que los elimine o elimine su cuenta. La búsqueda web y la obtención de páginas las proporcionamos nosotros a todos los usuarios, incluidos quienes usan su propio proveedor de IA: las consultas de búsqueda van a Staan y las direcciones web obtenidas a Jina AI; además se conservan en Valkey contadores de uso por hora y por día por persona (solo marcas de tiempo, sin contenido).
- **v5 (2026-10-26).** Se añadió el fin de tratamiento `paid_plans_waitlist` (consentimiento, doble confirmación): dirección de correo electrónico, idioma, registro del consentimiento y vínculo opcional con la cuenta, conservados hasta la baja o, como máximo, 3 meses después del anuncio del lanzamiento de los planes de pago; las inscripciones sin confirmar se eliminan a los 7 días. Almacenado en OVHcloud (UE); correos de confirmación a través de Resend.
- **v2 (2026-05-05).** Se añadió Resend, Inc. como subencargado para el envío de correos transaccionales (confirmaciones de eliminación, avisos de exportación de datos lista). Resend conserva los metadatos de los correos 30 días; no archiva el contenido. El fin `transactional_email` ahora hace referencia a Resend en el registro de bases jurídicas.
- **v1 (2026-05-04).** Publicación inicial.
