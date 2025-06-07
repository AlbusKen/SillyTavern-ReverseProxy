(function () {
    'use strict';

    const a = document.createElement("div");
    a.innerHTML = `<style>
    #reverse-proxy-button {
        background-color: #4CAF50; /* Green */
        border: none;
        color: white;
        padding: 8px 12px;
        text-align: center;
        text-decoration: none;
        display: inline-block;
        font-size: 14px;
        margin: 4px 2px;
        cursor: pointer;
        border-radius: 8px;
        transition: background-color 0.3s;
    }

    #reverse-proxy-button.running {
        background-color: #f44336; /* Red */
    }

    #reverse-proxy-button:hover {
        opacity: 0.8;
    }
</style>`;
    document.head.appendChild(a);


    function startProxy() {
        execute_command({ command: 'start cmd /k fangdai/打开反代服务.bat', requires_approval: true });
        localStorage.setItem('reverseProxyRunning', 'true');
        updateButtonState();

        // Create an iframe to run the browser-side script
        const iframe = document.createElement('iframe');
        iframe.id = 'proxy-runner-frame';
        iframe.src = 'extensions/SillyTavern-ReverseProxy/assets/proxy_runner.html';
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        
        toastr.success("反代服务已启动。");
    }

    function stopProxy() {
        execute_command({ command: 'fangdai/关闭端口.bat', requires_approval: true });
        localStorage.setItem('reverseProxyRunning', 'false');
        updateButtonState();

        // Remove the iframe
        const iframe = document.getElementById('proxy-runner-frame');
        if (iframe) {
            iframe.remove();
        }

        toastr.info("反代服务已停止。");
    }

    function updateButtonState() {
        const button = document.getElementById('reverse-proxy-button');
        if (!button) return;

        const isRunning = localStorage.getItem('reverseProxyRunning') === 'true';

        if (isRunning) {
            button.textContent = '停止反代';
            button.classList.add('running');
        } else {
            button.textContent = '启动反代';
            button.classList.remove('running');
        }
    }

    function toggleProxy() {
        const isRunning = localStorage.getItem('reverseProxyRunning') === 'true';
        if (isRunning) {
            stopProxy();
        } else {
            startProxy();
        }
    }

    function addProxyButton() {
        const container = document.querySelector('#extensions_buttons');
        if (container && !document.getElementById('reverse-proxy-button')) {
            const button = document.createElement('button');
            button.id = 'reverse-proxy-button';
            button.addEventListener('click', toggleProxy);
            container.appendChild(button);
            updateButtonState();
        }
    }

    // Periodically check for the button container
    const interval = setInterval(() => {
        const container = document.querySelector('#extensions_buttons');
        if (container) {
            clearInterval(interval);
            addProxyButton();
        }
    }, 1000);

})();
