(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrostedI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Chinese source strings are stable keys shared by the initial HTML and the
  // live panel. Values always reach the DOM as text, never as markup.
  const translations = [
    ['毛玻璃背景', 'Frosted Background', 'Fondo esmerilado'],
    ['语言', 'Language', 'Idioma'],
    ['连接中', 'Connecting', 'Conectando'],
    ['关闭控制面板', 'Close control panel', 'Cerrar panel de control'],
    ['背景效果预览', 'Background preview', 'Vista previa del fondo'],
    ['效果预览', 'Preview', 'Vista previa'],
    ['实时', 'Live', 'En vivo'],
    ['// 留一点风景给灵感', '// A little room for inspiration', '// Un lugar para la inspiración'],
    ['选择一张图片，或一段风景', 'Choose an image or a moving scene', 'Elige una imagen o un paisaje en movimiento'],
    ['未选择背景', 'No background', 'Sin fondo'],
    ['从本机选择文件', 'Choose a local file', 'Elige un archivo local'],
    ['选择图片', 'Choose image', 'Elegir imagen'],
    ['选择视频', 'Choose video', 'Elegir vídeo'],
    ['刷新', 'Refresh', 'Actualizar'],
    ['连接本机壁纸库', 'Connect your local wallpaper library', 'Conecta tu biblioteca local'],
    ['已连接本机壁纸库', 'Local wallpaper library connected', 'Biblioteca local conectada'],
    ['正在读取壁纸库…', 'Reading the wallpaper library…', 'Leyendo la biblioteca…'],
    ['搜索本机壁纸', 'Search local wallpapers', 'Buscar fondos locales'],
    ['仅显示可用于代码区的壁纸', 'Only wallpapers supported in the editor', 'Solo fondos compatibles con el editor'],
    ['选择文件夹', 'Choose folder', 'Elegir carpeta'],
    ['在创意工坊搜索', 'Search Workshop', 'Buscar en Workshop'],
    ['将打开 Steam 官方页面；订阅并下载后，请刷新本机壁纸库。', 'Opens the official Steam page. After subscribing and downloading, refresh your local library.', 'Abre la página oficial de Steam. Tras suscribirte y descargar, actualiza la biblioteca local.'],
    ['载入更多', 'Load more', 'Cargar más'],
    ['壁纸库较大，仅显示部分结果。', 'This library is large; only some results are shown.', 'La biblioteca es grande; solo se muestran algunos resultados.'],
    ['尚未连接壁纸库，请刷新自动检测或选择文件夹。', 'Refresh to detect your library, or choose a folder.', 'Actualiza para detectar la biblioteca o elige una carpeta.'],
    ['没有匹配的壁纸。', 'No matching wallpapers.', 'No hay fondos que coincidan.'],
    ['没有可用于代码区的壁纸，可取消筛选查看全部。', 'No supported wallpapers. Clear the filter to view all.', 'No hay fondos compatibles. Desmarca el filtro para ver todos.'],
    ['此文件夹中没有已下载的壁纸。', 'This folder has no downloaded wallpapers.', 'Esta carpeta no tiene fondos descargados.'],
    ['显示 {shown} / {count}', 'Showing {shown} / {count}', 'Mostrando {shown} / {count}'],
    ['场景壁纸', 'Scene', 'Escena'],
    ['网页壁纸', 'Web', 'Web'],
    ['应用壁纸', 'Application', 'Aplicación'],
    ['其他类型', 'Other', 'Otro'],
    ['此类型无法用于代码区。', 'This type cannot be used in the editor.', 'Este tipo no se puede usar en el editor.'],
    ['壁纸文件缺失或尚未下载完成。', 'The wallpaper file is missing or still downloading.', 'Falta el archivo del fondo o aún se está descargando.'],
    ['文件超过 500 MB。', 'The file exceeds 500 MB.', 'El archivo supera los 500 MB.'],
    ['壁纸项目无效。', 'The wallpaper project is invalid.', 'El proyecto del fondo no es válido.'],
    ['壁纸路径无效。', 'The wallpaper path is invalid.', 'La ruta del fondo no es válida.'],
    ['未命名壁纸', 'Untitled wallpaper', 'Fondo sin título'],
    ['应用壁纸：{title}', 'Apply wallpaper: {title}', 'Aplicar fondo: {title}'],
    ['玻璃质感', 'Glass effects', 'Efecto de cristal'],
    ['将效果恢复为默认值', 'Reset effects to defaults', 'Restablecer efectos predeterminados'],
    ['恢复默认', 'Reset', 'Restablecer'],
    ['效果预设', 'Effect presets', 'Efectos predefinidos'],
    ['柔和', 'Soft', 'Suave'],
    ['清透', 'Clear', 'Nítido'],
    ['专注', 'Focus', 'Enfoque'],
    ['模糊程度', 'Blur', 'Desenfoque'],
    ['清晰', 'Sharp', 'Nítido'],
    ['朦胧', 'Soft', 'Difuso'],
    ['背景浓度', 'Background opacity', 'Opacidad del fondo'],
    ['玻璃蒙层', 'Glass overlay', 'Capa de cristal'],
    ['亮度与色彩', 'Light & color', 'Luz y color'],
    ['亮度', 'Brightness', 'Brillo'],
    ['饱和度', 'Saturation', 'Saturación'],
    ['画面布局', 'Layout', 'Diseño'],
    ['随窗口自适应', 'Adapts to the window', 'Se adapta a la ventana'],
    ['背景缩放方式', 'Background sizing', 'Ajuste del fondo'],
    ['等比铺满', 'Cover', 'Cubrir'],
    ['完整显示', 'Fit', 'Encajar'],
    ['完整压缩', 'Full stretch', 'Estirar todo'],
    ['等比铺满，允许裁剪边缘', 'Fill the area proportionally; edges may be cropped.', 'Llena el área sin deformar; puede recortar los bordes.'],
    ['完整显示画面，可能留白', 'Show the entire scene; empty space may remain.', 'Muestra toda la imagen; puede dejar espacios vacíos.'],
    ['完整画面压缩到编辑区，不裁剪；可能改变比例', 'Fit the entire scene into the editor without cropping; proportions may change.', 'Ajusta toda la imagen al editor sin recortar; puede cambiar las proporciones.'],
    ['对齐位置', 'Position', 'Posición'],
    ['居中', 'Center', 'Centro'],
    ['顶部', 'Top', 'Arriba'],
    ['底部', 'Bottom', 'Abajo'],
    ['靠左', 'Left', 'Izquierda'],
    ['靠右', 'Right', 'Derecha'],
    ['视频播放', 'Video playback', 'Reproducción de vídeo'],
    ['暂停播放', 'Pause', 'Pausar'],
    ['继续播放', 'Play', 'Reproducir'],
    ['静音 · 循环', 'Muted · Looping', 'Sin sonido · En bucle'],
    ['播放速度', 'Playback speed', 'Velocidad'],
    ['切换窗口时暂停', 'Pause when unfocused', 'Pausar al cambiar de ventana'],
    ['减少后台资源占用', 'Use fewer resources in the background', 'Reduce el uso de recursos en segundo plano'],
    ['跟随系统减少动态效果', 'Respect reduced motion', 'Respetar movimiento reducido'],
    ['插件更新', 'Extension updates', 'Actualizaciones'],
    ['更新方式', 'Update mode', 'Modo de actualización'],
    ['自动更新', 'Automatic', 'Automático'],
    ['仅通知', 'Notify only', 'Solo avisar'],
    ['关闭', 'Off', 'Desactivado'],
    ['检查更新', 'Check for updates', 'Buscar actualizaciones'],
    ['应用', 'Apply', 'Aplicar'],
    ['待应用', 'Apply to finish', 'Aplicar para finalizar'],
    ['更新中', 'Updating', 'Actualizando'],
    ['实时生效', 'Live', 'En vivo'],
    ['点击应用将重载窗口，完成插件更新。', 'Apply will reload the window to finish the update.', 'Aplicar recargará la ventana para completar la actualización.'],
    ['点击应用将重载窗口，完成背景设置。', 'Apply will reload the window to finish background setup.', 'Aplicar recargará la ventana para completar la configuración del fondo.'],
    ['自动应用失败，请点击应用重试。', 'Automatic update failed. Click Apply to retry.', 'No se pudo aplicar el cambio. Pulsa Aplicar para reintentar.'],
    ['正在自动应用最新效果…', 'Applying the latest effects automatically…', 'Aplicando los últimos efectos automáticamente…'],
    ['效果调整将自动应用…', 'Effect changes will apply automatically…', 'Los cambios se aplicarán automáticamente…'],
    ['效果已调整，点击应用使其生效。', 'Effects changed. Click Apply to use them.', 'Efectos modificados. Pulsa Aplicar para usarlos.'],
    ['关闭背景并恢复', 'Disable background', 'Desactivar fondo'],
    ['视频', 'Video', 'Vídeo'],
    ['图片', 'Image', 'Imagen'],
    ['正在以兼容模式加载视频…', 'Loading video in compatibility mode…', 'Cargando el vídeo en modo de compatibilidad…'],
    ['无法读取视频，请确认文件可访问且不超过 500 MB。', 'Cannot read the video. Make sure the file is accessible and no larger than 500 MB.', 'No se puede leer el vídeo. Comprueba que el archivo sea accesible y no supere los 500 MB.'],
    ['此视频的容器或编码不受支持。', 'This video container or codec is not supported.', 'El contenedor o códec de este vídeo no es compatible.'],
    ['视频解码失败，请检查文件是否损坏或更换编码。', 'Video decoding failed. Check for a damaged file or try a different codec.', 'No se pudo decodificar el vídeo. Comprueba si el archivo está dañado o prueba otro códec.'],
    ['视频超出当前播放器的缓冲区容量，请选择较小的文件。', 'This video exceeds the player’s buffer capacity. Choose a smaller file.', 'Este vídeo supera la capacidad del búfer del reproductor. Elige un archivo más pequeño.'],
    ['无法读取预览，请重新选择图片。', 'Cannot load the preview. Choose the image again.', 'No se puede cargar la vista previa. Vuelve a elegir la imagen.'],
    ['正在检查…', 'Checking…', 'Buscando…'],
    ['正在更新…', 'Updating…', 'Actualizando…'],
    ['v{version} · 待重载', 'v{version} · Reload needed', 'v{version} · Recarga pendiente'],
    ['发现 v{version}', 'v{version} available', 'v{version} disponible'],
    ['处理中', 'Working', 'Procesando'],
    ['待重载', 'Reload needed', 'Recarga pendiente'],
    ['已启用', 'Enabled', 'Activado'],
    ['未启用', 'Disabled', 'Desactivado'],
    ['选择', 'Select', 'Seleccionar'],
  ];
  const dictionaries = { en: {}, 'zh-CN': {}, es: {} };
  for (const [key, en, es] of translations) {
    dictionaries.en[key] = en;
    dictionaries['zh-CN'][key] = key;
    dictionaries.es[key] = es;
  }
  for (const dictionary of Object.values(dictionaries)) Object.freeze(dictionary);
  Object.freeze(dictionaries);

  function normalizeLanguage(value) {
    return value === 'zh-CN' || value === 'es' ? value : 'en';
  }

  function t(language, key, params = {}) {
    const dictionary = dictionaries[normalizeLanguage(language)];
    const value = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
    return String(value).replace(/\{([^{}]+)\}/g, (token, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
  }

  return Object.freeze({ normalizeLanguage, t, dictionaries });
});
