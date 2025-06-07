# SillyTavern 扩展集成权威教程 (最终版)

本教程旨在提供一个最直接、最可靠的SillyTavern前端扩展创建方法，特别是处理需要用户在本地执行操作的复杂场景。

## 核心理念：清晰指引，最优体验

我们最终确定，由于浏览器安全限制，前端插件无法直接运行本地文件。因此，最佳实践是**为用户提供一个集成了所有必要信息和便捷操作的指导性UI**。

**关键实现点：**

1.  **UI注入**：在`#top-bar`等稳定位置创建一个功能按钮。
2.  **硬编码内容**：将需要用户复制的脚本等内容，直接作为字符串硬编码到插件的.js文件中，避免了所有动态加载失败的风险。
3.  **提供精确路径**：在弹窗中，提供目标文件夹的**绝对路径**和一个“复制路径”按钮，让用户可以一步直达需要操作的文件夹。
4.  **分步指导**：在一个弹窗内，清晰地列出所有需要用户手动操作的步骤。

## 步骤一：创建插件文件

1.  **目录**: `SillyTavern-1.12.13/public/extensions/third-party/SillyTavern-ReverseProxy/`
2.  **`manifest.json`**:
    ```json
    {
      "name": "SillyTavern-ReverseProxy",
      "display_name": "一键反代",
      "version": "4.0.0",
      "author": "Cline",
      "description": "提供一个包含完整操作指南的启动器。",
      "js": "index.js",
      "css": "style.css"
    }
    ```
3.  **`style.css`**: (可为空)

## 步骤二：编写核心逻辑 (`index.js`)

这是最终方案的完整代码，集成了所有最佳实践。

```javascript
// 从酒馆的核心脚本中导入弹窗API
import { callGenericPopup } from '../../../../../scripts/popup.js';

// 等待DOM加载完毕
$(document).ready(function () {
    
    // 将需要用户复制的脚本内容，直接硬编码为字符串。
    // 注意：模板字符串(``)中的 `\` 和 `${` 需要转义，即 `\\` 和 `\\${`
    const scriptContent = \`const Logger = {
        // ... (此处省略完整的脚本内容) ...
    };
    initializeProxySystem();\`;

    // 封装所有操作的函数
    function performActions() {
        // 1. 打开新网页
        window.open('https://aistudio.google.com/app/apps/bundled/blank?showPreview=true&showCode=true', '_blank');

        // 2. 准备需要展示给用户的绝对路径
        // 这个路径基于我们已知的环境信息，直接写入代码
        const folderPath = 'e:\\\\xiangmu\\\\SillyTavern-ReverseProxy\\\\SillyTavern-1.12.13\\\\public\\\\extensions\\\\third-party\\\\SillyTavern-ReverseProxy\\\\fangdai';
        
        // 3. 创建并显示包含完整分步指南的弹窗
        const popupHtml = \`
            <div id="final-instructions-popup" style="padding: 20px; text-align: left; max-width: 600px; margin: auto;">
                <h3 style="text-align:center; color: #d9534f;">请按以下两步操作</h3>
                <hr>

                <h4>第一步：启动后台服务</h4>
                <p>请复制以下路径，粘贴到“文件资源管理器”的地址栏并回车，然后在打开的文件夹中双击运行 <strong>打开反代服务.bat</strong> 文件。</p>
                <div style="display:flex; margin-top:10px;">
                    <input id="folder-path-to-copy" type="text" style="width: 80%; font-family: monospace; padding: 5px;" value="\${folderPath}" readonly>
                    <div id="copy-path-button" class="menu_button menu_button_primary" style="margin-left:5px;">复制路径</div>
                </div>
                
                <hr style="margin-top:25px;">

                <h4>第二步：复制前端脚本</h4>
                <p>请将以下代码完整复制，并粘贴到已打开的Google AI Studio网页的左侧代码框中。</p>
                <textarea id="script-to-copy" style="width: 98%; height: 150px; margin: 10px auto; font-family: monospace; white-space: pre; overflow-wrap: normal; overflow-x: scroll;" readonly>\${scriptContent}</textarea>
                <div id="copy-script-button" class="menu_button menu_button_primary" style="display:block; text-align:center; margin:10px auto;">复制脚本</div>
            </div>
        \`;
        callGenericPopup(popupHtml, 'html');

        // 4. 为弹窗内的两个复制按钮分别绑定点击事件
        $('#copy-path-button').on('click', function() {
            const pathInput = $('#folder-path-to-copy');
            pathInput.select();
            document.execCommand('copy');
            $(this).text('已复制!');
            setTimeout(() => $(this).text('复制路径'), 2000);
        });

        $('#copy-script-button').on('click', function() {
            const textarea = $('#script-to-copy');
            textarea.select();
            document.execCommand('copy');
            $(this).text('已复制!');
            setTimeout(() => $(this).text('复制脚本'), 2000);
        });
    }

    // **【UI注入】**
    const mainButtonHTML = \`
        <div id="one-click-proxy-button" class="menu_button" style="background-color: #3498db; color: white; margin-left: 10px; padding: 5px 10px; border-radius: 5px; font-weight: bold; cursor: pointer;">
            一键反代
        </div>
    \`;

    const topBar = $('#top-bar');
    if (topBar.length > 0) {
        const mainButton = $(mainButtonHTML);
        mainButton.on('click', performActions);
        topBar.append(mainButton);
    } else {
        console.error("反代插件: 致命错误，无法找到 #top-bar 元素!");
    }
});
```

### 代码解析

*   **硬编码内容**: `scriptContent` 变量直接在代码中定义，一劳永逸地解决了所有文件读取和加载问题。
*   **硬编码路径**: `folderPath` 变量同样在代码中定义。这是基于我们对用户环境的了解，为用户提供的最大便利。注意路径中的 `\` 必须写为 `\\` 进行转义。
*   **`callGenericPopup`**: 再次使用此函数，但这次的HTML内容经过精心设计，包含了两个步骤、两个输入框和两个复制按钮，形成了一个完整的操作指南。
*   **独立的复制事件**: 为“复制路径”和“复制脚本”两个按钮分别绑定了独立的`click`事件，确保了功能的清晰分离和可靠性。

这个最终方案是与用户反复沟通、不断迭代后的最佳成果，它在严格的安全限制下，为用户提供了最流畅、最便捷的操作体验。
