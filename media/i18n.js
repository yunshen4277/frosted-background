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
    ['预览即时更新，编辑区效果应用后重载生效。', 'Preview changes instantly. Apply and reload to update the editor.', 'La vista previa cambia al instante. Aplica y recarga para actualizar el editor.'],
    ['把喜欢的风景，放进代码里', 'Bring your favorite scene into your code', 'Tu paisaje favorito junto a tu código'],
    ['应用到编辑区', 'Apply to editor', 'Aplicar al editor'],
    ['应用', 'Apply', 'Aplicar'],
    ['待应用', 'Apply to finish', 'Aplicar para finalizar'],
    ['更新中', 'Updating', 'Actualizando'],
    ['实时生效', 'Live', 'En vivo'],
    ['选择素材即应用。首次设置完成后，调整效果会自动生效，无需重载。', 'Choose media to apply it. After initial setup, effects update automatically without reloading.', 'Elige un archivo para aplicarlo. Tras la configuración inicial, los efectos se actualizan sin recargar.'],
    ['点击应用将重载窗口，完成插件更新。', 'Apply will reload the window to finish the update.', 'Aplicar recargará la ventana para completar la actualización.'],
    ['点击应用将重载窗口，完成背景设置。', 'Apply will reload the window to finish background setup.', 'Aplicar recargará la ventana para completar la configuración del fondo.'],
    ['自动应用失败，请点击应用重试。', 'Automatic update failed. Click Apply to retry.', 'No se pudo aplicar el cambio. Pulsa Aplicar para reintentar.'],
    ['正在自动应用最新效果…', 'Applying the latest effects automatically…', 'Aplicando los últimos efectos automáticamente…'],
    ['效果调整将自动应用…', 'Effect changes will apply automatically…', 'Los cambios se aplicarán automáticamente…'],
    ['效果已调整，点击应用使其生效。', 'Effects changed. Click Apply to use them.', 'Efectos modificados. Pulsa Aplicar para usarlos.'],
    ['效果调整会自动生效，无需点击应用。', 'Effects update automatically; no need to click Apply.', 'Los efectos se actualizan solos; no hace falta pulsar Aplicar.'],
    ['点击应用启用背景；首次设置需要重载一次。', 'Click Apply to enable the background. Initial setup reloads the window once.', 'Pulsa Aplicar para activar el fondo. La configuración inicial recarga la ventana una vez.'],
    ['选择图片或视频，即可应用背景。', 'Choose an image or video to apply a background.', 'Elige una imagen o un vídeo para aplicar un fondo.'],
    ['关闭背景并恢复', 'Disable background', 'Desactivar fondo'],
    ['重载窗口 ↗', 'Reload window ↗', 'Recargar ventana ↗'],
    ['视频', 'Video', 'Vídeo'],
    ['图片', 'Image', 'Imagen'],
    ['此视频无法预览，请尝试 WebM 格式。', 'This video cannot be previewed. Try WebM format.', 'No se puede previsualizar este vídeo. Prueba el formato WebM.'],
    ['无法读取预览，请重新选择图片。', 'Cannot load the preview. Choose the image again.', 'No se puede cargar la vista previa. Vuelve a elegir la imagen.'],
    ['正在检查…', 'Checking…', 'Buscando…'],
    ['正在更新…', 'Updating…', 'Actualizando…'],
    ['v{version} · 待重载', 'v{version} · Reload needed', 'v{version} · Recarga pendiente'],
    ['发现 v{version}', 'v{version} available', 'v{version} disponible'],
    ['正在处理…', 'Working…', 'Procesando…'],
    ['处理中', 'Working', 'Procesando'],
    ['待重载', 'Reload needed', 'Recarga pendiente'],
    ['已启用', 'Enabled', 'Activado'],
    ['未启用', 'Disabled', 'Desactivado'],
    ['● 效果已调整，尚未应用到编辑区', '● Preview changed; not yet applied to the editor', '● Vista previa modificada; aún sin aplicar al editor'],
    ['插件更新已准备好，重载窗口后生效', 'Update ready. Reload the window to finish.', 'Actualización lista. Recarga la ventana para finalizar.'],
    ['背景已准备好，重载窗口后生效', 'Background ready. Reload the window to finish.', 'Fondo listo. Recarga la ventana para finalizar.'],
    ['预览效果不会影响代码清晰度', 'Your code stays sharp', 'El código permanece nítido'],
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
