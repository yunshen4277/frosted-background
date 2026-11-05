'use strict';

// Native VS Code messages use the persisted panel language, independently of
// VS Code's own display language. Unknown diagnostics remain intact for support.
const messages = {
  '区域效果文件无效或缺失，请重新安装插件。': ['The region effects file is invalid or missing. Reinstall the extension.', 'El archivo de efectos por zonas no es válido o falta. Reinstala la extensión.'],
  '插件运行文件无效或过大，请重新安装插件。': ['An extension runtime file is invalid or too large. Reinstall the extension.', 'Un archivo de la extensión no es válido o es demasiado grande. Reinstala la extensión.'],
  '实时背景配置地址无效，已停止操作。': ['The live background settings address is invalid. The operation was stopped.', 'La dirección de los ajustes del fondo en tiempo real no es válida. Se detuvo la operación.'],
  '视频播放器缓存地址无效，已停止操作。': ['The cached video player address is invalid. The operation was stopped.', 'La dirección del reproductor de vídeo en caché no es válida. Se detuvo la operación.'],
  '实时背景配置不是有效的普通文件，已停止操作。': ['Live background settings are not a valid regular file. The operation was stopped.', 'Los ajustes del fondo en tiempo real no son un archivo normal válido. Se detuvo la operación.'],
  '实时背景配置无效，已停止操作。': ['Live background settings are invalid. The operation was stopped.', 'Los ajustes del fondo en tiempo real no son válidos. Se detuvo la operación.'],
  '实时背景配置过大，已停止操作。': ['Live background settings are too large. The operation was stopped.', 'Los ajustes del fondo en tiempo real son demasiado grandes. Se detuvo la operación.'],
  '当前背景尚不支持实时调整，请重新应用背景。': ['This background does not support live adjustments yet. Apply the background again.', 'Este fondo todavía no admite ajustes en tiempo real. Vuelve a aplicar el fondo.'],
  '实时背景配置与界面文件不一致，请重新应用背景。': ['Live settings and the interface file do not match. Apply the background again.', 'Los ajustes en tiempo real y el archivo de interfaz no coinciden. Vuelve a aplicar el fondo.'],
  '背景已实时应用，无需重载。': ['Background applied live. No reload needed.', 'Fondo aplicado al instante. No hace falta recargar.'],
  '背景已实时应用，但设置保存失败，可稍后重试：{error}': ['Background applied live, but settings could not be saved. Retry later: {error}', 'El fondo se aplicó al instante, pero no se guardaron los ajustes. Inténtalo de nuevo: {error}'],
  '首次启用或升级后需要重载一次，之后更换背景和调整效果将自动生效。': ['Reload once after first enabling or upgrading. Future background and effect changes apply automatically.', 'Recarga una vez al activar o actualizar. Después, los cambios de fondo y efectos se aplicarán automáticamente.'],
  '请先应用背景并重载一次，以启用实时调整。': ['Apply the background and reload once to enable live adjustments.', 'Aplica el fondo y recarga una vez para activar los ajustes en tiempo real.'],
  '毛玻璃背景': ['Frosted Background', 'Fondo esmerilado'],
  '毛玻璃': ['Frosted', 'Fondo'],
  '背景控制面板': ['Background Controls', 'Controles de fondo'],
  '打开毛玻璃背景控制面板': ['Open Frosted Background controls', 'Abrir los controles del fondo'],
  '无法保存语言选择：{error}': ['Could not save the language: {error}', 'No se pudo guardar el idioma: {error}'],
  '此插件需要桌面版 VS Code，网页版不支持编辑区背景。': ['This extension requires desktop VS Code. Editor backgrounds are not supported in the web version.', 'Esta extensión requiere VS Code de escritorio. La versión web no admite fondos en el editor.'],
  '无法写入 VS Code 安装目录。请使用安装在当前用户目录、且目录可写的 VS Code；macOS 请先将应用移到“应用程序”。详细信息：{error}': ['Cannot write to the VS Code installation folder. Use a writable installation in your user folder; on macOS, move the app to Applications first. Details: {error}', 'No se puede escribir en la carpeta de instalación de VS Code. Usa una instalación con permiso de escritura en tu carpeta de usuario; en macOS, mueve primero la app a Aplicaciones. Detalles: {error}'],
  '磁盘空间不足，请释放空间后再试。': ['There is not enough disk space. Free some space and try again.', 'No hay suficiente espacio en disco. Libera espacio e inténtalo de nuevo.'],
  '正在处理背景，请稍候。': ['A background operation is in progress. Please wait.', 'Hay una operación de fondo en curso. Espera un momento.'],
  '毛玻璃背景：{error}': ['Frosted Background: {error}', 'Fondo esmerilado: {error}'],
  '查看日志': ['Show Log', 'Ver registro'],
  '毛玻璃背景需要修改当前 VS Code 的界面文件。': ['Frosted Background needs to modify this VS Code installation’s interface files.', 'Fondo esmerilado necesita modificar los archivos de interfaz de esta instalación de VS Code.'],
  '官方扩展接口不支持代码区图片或视频背景。启用后可能出现“安装似乎已损坏”的完整性提示；可通过“关闭背景并恢复原状”撤销。此设置影响这份 VS Code 安装的所有窗口，更新 VS Code 后需要重新应用。': ['The official extension API does not support image or video backgrounds in the editor. Enabling this may trigger an installation integrity warning. Use “Disable Background and Restore” to undo it. This affects all windows of this VS Code installation and must be reapplied after VS Code updates.', 'La API oficial de extensiones no admite fondos de imagen o vídeo en el editor. Activar esta función puede mostrar un aviso de integridad de la instalación. Usa «Desactivar fondo y restaurar» para deshacerlo. Afecta a todas las ventanas de esta instalación y debe aplicarse de nuevo después de actualizar VS Code.'],
  '启用背景': ['Enable Background', 'Activar fondo'],
  '{message} 重载窗口后生效；其他已打开窗口也需重载。': ['{message} Reload this window to apply it. Reload other open windows too.', '{message} Recarga esta ventana para aplicar el cambio. Recarga también las demás ventanas abiertas.'],
  '立即重载': ['Reload Now', 'Recargar ahora'],
  '重载窗口：{error}': ['Reload window: {error}', 'Recargar ventana: {error}'],
  '正在应用毛玻璃背景…': ['Applying Frosted Background…', 'Aplicando el fondo esmerilado…'],
  '已应用：{path}': ['Applied: {path}', 'Aplicado: {path}'],
  '背景已应用，但设置保存失败：{error}': ['The background was applied, but settings could not be saved: {error}', 'El fondo se aplicó, pero no se pudieron guardar los ajustes: {error}'],
  '背景已准备好。': ['The background is ready.', 'El fondo está listo.'],
  '背景已应用，重载窗口后生效。但设置保存失败，可稍后重试：{error}': ['The background was applied and will appear after reloading. Settings could not be saved; you can retry later: {error}', 'El fondo se aplicó y aparecerá al recargar. No se pudieron guardar los ajustes; puedes intentarlo más tarde: {error}'],
  '背景已应用，重载窗口后生效。其他已打开窗口也需重载。': ['The background was applied. Reload this window and any other open windows to see it.', 'El fondo se aplicó. Recarga esta ventana y las demás ventanas abiertas para verlo.'],
  '选择背景视频（静音循环；建议 WebM）': ['Choose a background video (muted loop; WebM recommended)', 'Elige un vídeo de fondo (bucle sin sonido; se recomienda WebM)'],
  '选择背景图片': ['Choose a background image', 'Elige una imagen de fondo'],
  '设为毛玻璃背景': ['Use as Background', 'Usar como fondo'],
  '视频': ['Video', 'Vídeo'],
  '图片': ['Image', 'Imagen'],
  '请选择本机上的图片或视频。远程工作区中的文件需要先保存到本机。': ['Choose an image or video on this computer. Save remote workspace files locally first.', 'Elige una imagen o un vídeo de este equipo. Guarda primero los archivos remotos en el equipo.'],
  '已移除当前安装的背景注入。': ['Removed the background from this installation.', 'Se eliminó el fondo de esta instalación.'],
  '清理旧资源：{error}': ['Clean up old assets: {error}', 'Limpiar recursos anteriores: {error}'],
  '已关闭背景；部分旧资源仍被占用，可重载后再次关闭背景以清理。': ['The background is disabled. Some old assets are still in use; reload and disable the background again to clean them up.', 'El fondo está desactivado. Algunos recursos anteriores siguen en uso; recarga y vuelve a desactivar el fondo para eliminarlos.'],
  '已恢复原状。': ['The original interface has been restored.', 'Se ha restaurado la interfaz original.'],
  '已恢复原状。 重载窗口后生效。': ['The original interface has been restored. Reload the window to apply it.', 'Se ha restaurado la interfaz original. Recarga la ventana para aplicar el cambio.'],
  '已关闭背景；部分旧资源仍被占用，可重载后再次关闭背景以清理。 重载窗口后生效。': ['The background is disabled. Some old assets are still in use; reload and disable the background again to clean them up. Reload the window to apply the change.', 'El fondo está desactivado. Algunos recursos anteriores siguen en uso; recarga y vuelve a desactivar el fondo para eliminarlos. Recarga la ventana para aplicar el cambio.'],
  '{message} 重载窗口后生效。': ['{message} Reload the window to apply it.', '{message} Recarga la ventana para aplicar el cambio.'],
  '插件更新：{error}': ['Extension update: {error}', 'Actualización de la extensión: {error}'],
  '选择图片': ['Choose Image', 'Elegir imagen'],
  '选择视频': ['Choose Video', 'Elegir vídeo'],
  '选择背景类型': ['Choose a background type', 'Elige el tipo de fondo'],
  '已应用': ['Applied', 'Aplicado'],
  '未应用': ['Not applied', 'Sin aplicar'],
  '；上次选择：{name}': ['; last selected: {name}', '; última selección: {name}'],
  '毛玻璃背景：{status}{media}。当前 VS Code {version}。': ['Frosted Background: {status}{media}. VS Code {version}.', 'Fondo esmerilado: {status}{media}. VS Code {version}.'],
  '毛玻璃效果设置已修改，应用后重载窗口即可生效。': ['Background settings changed. Apply them and reload the window to see the changes.', 'Los ajustes del fondo han cambiado. Aplícalos y recarga la ventana para ver los cambios.'],
  '应用设置': ['Apply Settings', 'Aplicar ajustes'],
  '新版背景效果已自动准备好。': ['The updated background is ready.', 'El fondo actualizado está listo.'],
  '自动迁移背景未完成：{error}': ['The background migration did not finish: {error}', 'No se completó la migración del fondo: {error}'],
  '毛玻璃背景已更新，请在控制面板中应用一次，让新效果生效。': ['Frosted Background was updated. Apply it once in the controls to enable the new effects.', 'Fondo esmerilado se ha actualizado. Aplícalo una vez en los controles para activar los nuevos efectos.'],
  '背景尚未应用到这份 VS Code 安装（例如更新之后），可以在控制面板重新应用。': ['The background is not applied to this VS Code installation, for example after an update. Apply it again in the controls.', 'El fondo no está aplicado en esta instalación de VS Code, por ejemplo tras una actualización. Vuelve a aplicarlo en los controles.'],
  '打开控制面板': ['Open Controls', 'Abrir controles'],
  '启动检查：{error}': ['Startup check: {error}', 'Comprobación al iniciar: {error}'],
  '已载入预览，调整后点击“应用到编辑区”。': ['Preview loaded. Adjust it, then choose “Apply to Editor”.', 'Vista previa cargada. Ajústala y pulsa «Aplicar al editor».'],
  '请先选择一张图片或一段视频。': ['Choose an image or video first.', 'Elige primero una imagen o un vídeo.'],
  '背景已应用，重载窗口后在编辑区生效。': ['The background was applied. Reload the window to see it in the editor.', 'El fondo se aplicó. Recarga la ventana para verlo en el editor.'],
  '背景已关闭，重载窗口后恢复原界面。': ['The background is disabled. Reload the window to restore the original interface.', 'El fondo está desactivado. Recarga la ventana para restaurar la interfaz original.'],
  '尚未绑定 GitHub 发布仓库。': ['No GitHub release repository is configured.', 'No se ha configurado un repositorio de versiones de GitHub.'],
  '已安装 {version}，重载窗口后加载新版。': ['Version {version} is installed. Reload the window to load it.', 'La versión {version} está instalada. Recarga la ventana para cargarla.'],
  '更新来自此插件的 GitHub 发布仓库。': ['Updates come from this extension’s GitHub releases.', 'Las actualizaciones proceden de las versiones de esta extensión en GitHub.'],
  '尚未绑定 GitHub 发布仓库，当前版本不能在线更新。': ['No GitHub release repository is configured, so this version cannot update online.', 'No se ha configurado un repositorio de versiones de GitHub; esta versión no puede actualizarse en línea.'],
  '正在检查 GitHub 更新…': ['Checking GitHub for updates…', 'Buscando actualizaciones en GitHub…'],
  '当前已是最新发布版本。': ['You have the latest release.', 'Tienes la última versión publicada.'],
  '发现新版本 {version}。': ['Version {version} is available.', 'La versión {version} está disponible.'],
  '毛玻璃背景有新版本 {version}。': ['Frosted Background {version} is available.', 'Fondo esmerilado {version} está disponible.'],
  '安装更新': ['Install Update', 'Instalar actualización'],
  '查看更新': ['View Update', 'Ver actualización'],
  '正在下载并验证 {version}…': ['Downloading and verifying {version}…', 'Descargando y verificando {version}…'],
  '无法定位本机更新缓存目录。': ['Cannot locate the local update cache.', 'No se puede localizar la caché local de actualizaciones.'],
  '自动安装已停止；可手动检查并安装此版本。': ['Automatic installation stopped. You can check and install this version manually.', 'La instalación automática se detuvo. Puedes buscar e instalar esta versión manualmente.'],
  '更新未完成：{error}': ['The update did not finish: {error}', 'La actualización no se completó: {error}'],
  '毛玻璃背景新版已安装，重载后启用。背景渲染器迁移完成后可能还会提示再重载一次。': ['The Frosted Background update is installed. Reload to activate it. A second reload may be needed after the background renderer is migrated.', 'La actualización de Fondo esmerilado está instalada. Recarga para activarla. Puede que se solicite otra recarga tras migrar el renderizador del fondo.'],
  '重载窗口': ['Reload Window', 'Recargar ventana'],
  '无法定位 VS Code 安装目录。仅支持桌面版 VS Code。': ['Cannot locate the VS Code installation. Only desktop VS Code is supported.', 'No se encuentra la instalación de VS Code. Solo se admite VS Code de escritorio.'],
  '未找到兼容的 VS Code 界面文件。当前版本可能尚不受支持。': ['No compatible VS Code interface file was found. This version may not be supported yet.', 'No se encontró un archivo de interfaz compatible. Es posible que esta versión de VS Code aún no sea compatible.'],
  '毛玻璃背景标记不完整，已停止修改。请先检查或恢复界面文件。': ['Background markers are incomplete. Changes stopped; inspect or restore the interface file first.', 'Las marcas del fondo están incompletas. Se detuvieron los cambios; revisa o restaura primero el archivo de interfaz.'],
  'VS Code 界面文件格式不受支持，未修改原文件。': ['The VS Code interface format is unsupported. The original file was not changed.', 'El formato de la interfaz no es compatible. No se modificó el archivo original.'],
  '背景资源目录不是普通目录，已停止操作。': ['The background asset folder is not a regular directory. The operation stopped.', 'La carpeta de recursos del fondo no es un directorio normal. Se detuvo la operación.'],
  '背景资源目录已存在，但不属于本插件。未修改其中的文件。': ['The existing background asset folder does not belong to this extension. Its files were not changed.', 'La carpeta de recursos existente no pertenece a esta extensión. No se modificaron sus archivos.'],
  '背景资源目录所有权无法确认，已停止操作。': ['Cannot verify ownership of the background asset folder. The operation stopped.', 'No se puede verificar la propiedad de la carpeta de recursos. Se detuvo la operación.'],
  '背景操作锁异常，已停止操作。': ['The background operation lock is invalid. The operation stopped.', 'El bloqueo de la operación del fondo no es válido. Se detuvo la operación.'],
  '另一个 VS Code 窗口正在修改背景，请稍后重试。': ['Another VS Code window is changing the background. Try again shortly.', 'Otra ventana de VS Code está cambiando el fondo. Inténtalo de nuevo en un momento.'],
  '界面文件不是普通文件，已停止操作。': ['The interface file is not a regular file. The operation stopped.', 'El archivo de interfaz no es un archivo normal. Se detuvo la operación.'],
  '界面文件被其他程序修改，请重新执行背景命令。': ['Another program changed the interface file. Run the background command again.', 'Otro programa modificó el archivo de interfaz. Ejecuta de nuevo el comando del fondo.'],
  '背景文件过大，请选择不超过 500 MB 的文件。': ['The background file is too large. Choose a file no larger than 500 MB.', 'El archivo del fondo es demasiado grande. Elige uno de 500 MB o menos.'],
  '所选背景文件为空。': ['The selected background file is empty.', 'El archivo de fondo seleccionado está vacío.'],
  '背景资源目标不是普通文件，已停止操作。': ['The background asset target is not a regular file. The operation stopped.', 'El destino del recurso de fondo no es un archivo normal. Se detuvo la operación.'],
  '现有背景资源被修改，已停止覆盖。请先恢复背景。': ['An existing background asset was modified. Overwriting stopped; restore the background first.', 'Se modificó un recurso del fondo. Se detuvo la sobrescritura; restaura primero el fondo.'],
  '无法写入 VS Code 安装目录。请使用有写入权限的用户安装版，或由系统管理员授予该目录写入权限。原界面文件会保留。': ['Cannot write to the VS Code installation folder. Use a writable user installation or ask your administrator for folder write access. The original interface file is preserved.', 'No se puede escribir en la carpeta de instalación. Usa una instalación de usuario con permiso de escritura o pide acceso al administrador. Se conserva el archivo de interfaz original.'],
  '请选择 PNG、JPG、JPEG、GIF、WebP、BMP、AVIF 图片，或 MP4、WebM 视频。': ['Choose a PNG, JPG, JPEG, GIF, WebP, BMP or AVIF image, or an MP4 or WebM video.', 'Elige una imagen PNG, JPG, JPEG, GIF, WebP, BMP o AVIF, o un vídeo MP4 o WebM.'],
  '请选择有效且非空的本地媒体文件。': ['Choose a valid, nonempty local media file.', 'Elige un archivo multimedia local válido y no vacío.'],
  '插件渲染文件缺失，请重新安装插件。': ['The extension’s renderer file is missing. Reinstall the extension.', 'Falta el archivo del renderizador. Vuelve a instalar la extensión.'],
  '视频播放器文件缺失，请重新安装插件。': ['The video player file is missing. Reinstall the extension.', 'Falta el archivo del reproductor de vídeo. Vuelve a instalar la extensión.'],
  '背景已在另一个窗口中改变，请重新应用。': ['The background changed in another window. Apply it again.', 'El fondo cambió en otra ventana. Vuelve a aplicarlo.'],
  '界面备份已被修改，已停止操作。': ['The interface backup was modified. The operation stopped.', 'Se modificó la copia de seguridad de la interfaz. Se detuvo la operación.'],
  '缓存背景在更新期间被修改，已停止应用。': ['The cached background changed during the update. Applying it stopped.', 'El fondo en caché cambió durante la actualización. Se detuvo la aplicación.'],
  '背景缓存配置包含未知的 HTML 编码。': ['The cached background configuration contains unknown HTML encoding.', 'La configuración del fondo en caché contiene una codificación HTML desconocida.'],
  '当前安装没有可复用的背景，请先选择背景。': ['This installation has no reusable background. Choose a background first.', 'Esta instalación no tiene un fondo reutilizable. Elige primero un fondo.'],
  '背景缓存目录缺失，请重新选择背景。': ['The background cache folder is missing. Choose the background again.', 'Falta la carpeta de caché del fondo. Vuelve a elegir el fondo.'],
  '背景注入结构与本插件不符，已停止自动更新。': ['The background injection does not match this extension. Automatic updating stopped.', 'La estructura del fondo no coincide con esta extensión. Se detuvo la actualización automática.'],
  '无法读取已应用的背景配置，请重新选择背景。': ['Cannot read the applied background configuration. Choose the background again.', 'No se puede leer la configuración del fondo aplicado. Vuelve a elegir el fondo.'],
  '背景缓存配置无效。': ['The cached background configuration is invalid.', 'La configuración del fondo en caché no es válida.'],
  '缓存背景地址不属于本插件的本地资源。': ['The cached background address is not a local asset owned by this extension.', 'La dirección del fondo en caché no pertenece a los recursos locales de esta extensión.'],
  '缓存背景类型不匹配。': ['The cached background type does not match.', 'El tipo del fondo en caché no coincide.'],
  '缓存背景不是有效的普通媒体文件。': ['The cached background is not a valid regular media file.', 'El fondo en caché no es un archivo multimedia normal válido.'],
  '缓存背景超过允许大小。': ['The cached background exceeds the size limit.', 'El fondo en caché supera el tamaño permitido.'],
  '缓存背景校验失败，请重新选择背景。': ['The cached background failed verification. Choose the background again.', 'La verificación del fondo en caché falló. Vuelve a elegir el fondo.'],
  '更新操作已取消。': ['The update was canceled.', 'Se canceló la actualización.'],
  'GitHub 仓库必须是有效的 owner/repository。': ['The GitHub repository must be a valid owner/repository.', 'El repositorio de GitHub debe tener el formato válido propietario/repositorio.'],
  'GitHub 仓库名称无效。': ['The GitHub repository name is invalid.', 'El nombre del repositorio de GitHub no es válido.'],
  '更新版本必须是稳定版 X.Y.Z。': ['The update version must be a stable X.Y.Z release.', 'La actualización debe ser una versión estable X.Y.Z.'],
  '扩展标识无效。': ['The extension identifier is invalid.', 'El identificador de la extensión no es válido.'],
  '更新下载地址无效。': ['The update download address is invalid.', 'La dirección de descarga de la actualización no es válida.'],
  '更新仅允许无凭据的 HTTPS 地址。': ['Updates require HTTPS addresses without embedded credentials.', 'Las actualizaciones requieren direcciones HTTPS sin credenciales incorporadas.'],
  '更新地址不属于指定 GitHub 仓库。': ['The update address does not belong to the configured GitHub repository.', 'La dirección de actualización no pertenece al repositorio de GitHub configurado.'],
  '更新地址的仓库、版本标签或资源名称不匹配。': ['The update repository, version tag or asset name does not match.', 'El repositorio, la etiqueta de versión o el nombre del recurso no coinciden.'],
  '更新信息无效。': ['The update information is invalid.', 'La información de actualización no es válida.'],
  '更新文件超过允许大小。': ['The update file exceeds the size limit.', 'El archivo de actualización supera el tamaño permitido.'],
  '更新下载未完成。': ['The update download was incomplete.', 'La descarga de la actualización quedó incompleta.'],
  '更新下载连接超时。': ['The update download connection timed out.', 'Se agotó el tiempo de conexión de la descarga.'],
  '更新下载超时。': ['The update download timed out.', 'Se agotó el tiempo de descarga de la actualización.'],
  '已拒绝不受信任的更新重定向。': ['An untrusted update redirect was rejected.', 'Se rechazó una redirección de actualización no fiable.'],
  '更新服务器响应格式无效。': ['The update server response format is invalid.', 'El formato de respuesta del servidor de actualizaciones no es válido.'],
  '更新服务器返回了不支持的内容编码。': ['The update server returned an unsupported content encoding.', 'El servidor de actualizaciones devolvió una codificación no compatible.'],
  '更新重定向次数过多或地址缺失。': ['There were too many update redirects, or an address was missing.', 'Hay demasiadas redirecciones de actualización o falta una dirección.'],
  '更新重定向地址无效。': ['The update redirect address is invalid.', 'La dirección de redirección de la actualización no es válida.'],
  '更新重定向次数过多。': ['There were too many update redirects.', 'Hay demasiadas redirecciones de actualización.'],
  'GitHub 更新请求失败（HTTP {status}）。': ['The GitHub update request failed (HTTP {status}).', 'La solicitud de actualización a GitHub falló (HTTP {status}).'],
  '更新发布必须是公开稳定版。': ['The update must be a public stable release.', 'La actualización debe ser una versión pública estable.'],
  '更新缺少版本标签。': ['The update is missing its version tag.', 'Falta la etiqueta de versión de la actualización.'],
  '更新发布缺少资源。': ['The release is missing its assets.', 'Faltan los recursos de la versión publicada.'],
  '更新发布必须包含唯一的 {name}。': ['The release must contain exactly one {name}.', 'La versión publicada debe contener exactamente un {name}.'],
  '更新发布资源无效或超过允许大小。': ['A release asset is invalid or exceeds the size limit.', 'Un recurso de la versión no es válido o supera el tamaño permitido.'],
  '下载文件不是有效 VSIX 压缩包。': ['The download is not a valid VSIX archive.', 'El archivo descargado no es un paquete VSIX válido.'],
  '不支持此 VSIX 压缩包结构。': ['This VSIX archive structure is unsupported.', 'La estructura de este paquete VSIX no es compatible.'],
  'VSIX 文件目录损坏。': ['The VSIX file directory is corrupt.', 'El directorio de archivos del VSIX está dañado.'],
  'VSIX 文件目录越界。': ['The VSIX file directory is out of bounds.', 'El directorio de archivos del VSIX está fuera de los límites.'],
  'VSIX 包含不安全的文件路径。': ['The VSIX contains an unsafe file path.', 'El VSIX contiene una ruta de archivo no segura.'],
  'VSIX 包含重复、加密或不支持的文件。': ['The VSIX contains duplicate, encrypted or unsupported files.', 'El VSIX contiene archivos duplicados, cifrados o no compatibles.'],
  'VSIX 文件目录长度不匹配。': ['The VSIX file directory length does not match.', 'La longitud del directorio de archivos del VSIX no coincide.'],
  'VSIX 缺少 {name}。': ['The VSIX is missing {name}.', 'Falta {name} en el VSIX.'],
  'VSIX 清单大小或文件头无效。': ['The VSIX manifest size or header is invalid.', 'El tamaño o la cabecera del manifiesto VSIX no son válidos.'],
  'VSIX 清单文件头不匹配。': ['The VSIX manifest header does not match.', 'La cabecera del manifiesto VSIX no coincide.'],
  'VSIX 清单压缩长度不匹配。': ['The VSIX manifest compressed length does not match.', 'La longitud comprimida del manifiesto VSIX no coincide.'],
  'VSIX 清单无法解压或超过允许大小。': ['The VSIX manifest cannot be decompressed or exceeds the size limit.', 'El manifiesto VSIX no puede descomprimirse o supera el tamaño permitido.'],
  'VSIX 清单校验失败。': ['VSIX manifest verification failed.', 'La verificación del manifiesto VSIX falló.'],
  'VSIX 内的扩展身份或版本与发布信息不一致。': ['The extension identity or version in the VSIX does not match the release.', 'La identidad o versión de la extensión en el VSIX no coincide con la publicación.'],
  'VSIX 缺少有效的 VS Code 版本要求。': ['The VSIX has no valid VS Code version requirement.', 'El VSIX no incluye un requisito válido de versión de VS Code.'],
  'VSIX XML 清单包含不支持的声明。': ['The VSIX XML manifest contains an unsupported declaration.', 'El manifiesto XML del VSIX contiene una declaración no compatible.'],
  'VSIX XML 清单身份无效。': ['The VSIX XML manifest identity is invalid.', 'La identidad del manifiesto XML del VSIX no es válida.'],
  'VSIX XML 清单包含重复属性。': ['The VSIX XML manifest contains duplicate attributes.', 'El manifiesto XML del VSIX contiene atributos duplicados.'],
  'VSIX XML 清单身份或版本不匹配。': ['The VSIX XML manifest identity or version does not match.', 'La identidad o versión del manifiesto XML del VSIX no coincide.'],
  '更新版本必须高于当前已安装版本。': ['The update version must be newer than the installed version.', 'La versión de actualización debe ser posterior a la instalada.'],
  '更新缓存目录必须是本机绝对路径。': ['The update cache must be an absolute local path.', 'La caché de actualizaciones debe ser una ruta local absoluta.'],
  '更新清单的身份、版本、文件名或校验值不匹配。': ['The update manifest identity, version, filename or checksum does not match.', 'La identidad, versión, nombre de archivo o suma de verificación del manifiesto de actualización no coinciden.'],
  '更新文件 SHA-256 校验失败，未安装。': ['The update failed SHA-256 verification and was not installed.', 'La actualización falló la verificación SHA-256 y no se instaló.'],
  '更新缓存目录必须是普通目录。': ['The update cache must be a regular directory.', 'La caché de actualizaciones debe ser un directorio normal.'],
  '{label}不是有效 JSON。': ['{label} is not valid JSON.', '{label} no es un JSON válido.'],
  '{label}格式无效。': ['{label} has an invalid format.', '{label} tiene un formato no válido.'],
  'GitHub 发布信息': ['GitHub release information', 'La información de la versión de GitHub'],
  '扩展清单': ['The extension manifest', 'El manifiesto de la extensión'],
  '更新清单': ['The update manifest', 'El manifiesto de actualización'],
};

function normalizeLanguage(language) {
  return language === 'zh-CN' || language === 'es' ? language : 'en';
}

function t(language, key, params = {}) {
  const locale = normalizeLanguage(language);
  const entry = Object.hasOwn(messages, key) ? messages[key] : undefined;
  const text = locale === 'zh-CN' || !entry ? key : entry[locale === 'es' ? 1 : 0];
  return String(text).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

function localizedError(key, params = {}) {
  const error = new Error(t('zh-CN', key, params));
  error.localizationKey = key;
  error.localizationParams = params;
  return error;
}

function translateDiagnostic(language, message) {
  const patterns = [
    [/^GitHub 更新请求失败（HTTP (\d+)）。$/, 'GitHub 更新请求失败（HTTP {status}）。', 'status'],
    [/^更新发布必须包含唯一的 (.+)。$/, '更新发布必须包含唯一的 {name}。', 'name'],
    [/^VSIX 缺少 (.+)。$/, 'VSIX 缺少 {name}。', 'name'],
    [/^(.+)不是有效 JSON。$/, '{label}不是有效 JSON。', 'label'],
    [/^(.+)格式无效。$/, '{label}格式无效。', 'label']
  ];
  if (Object.hasOwn(messages, message)) return t(language, message);
  for (const [pattern, key, parameter] of patterns) {
    const match = pattern.exec(message);
    if (match) return t(language, key, { [parameter]: parameter === 'label' ? t(language, match[1]) : match[1] });
  }
  return message;
}

function describeError(language, error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error);
  const message = error?.localizationKey ? t(language, error.localizationKey, error.localizationParams) : translateDiagnostic(language, raw);
  if (error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    return t(language, '无法写入 VS Code 安装目录。请使用安装在当前用户目录、且目录可写的 VS Code；macOS 请先将应用移到“应用程序”。详细信息：{error}', { error: message });
  }
  if (error?.code === 'ENOSPC') return t(language, '磁盘空间不足，请释放空间后再试。');
  return message;
}

module.exports = { normalizeLanguage, t, localizedError, describeError };
