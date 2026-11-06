# 形象与第三方桌宠

## 本插件自带形象

`pet.svg` / 客户端内联 SVG 是**为本插件原创**的 Q 版角色，气质参考 DeepSeek 官方蓝鲸标识，**不是**社区同人「蓝色大肥鱼 / 鲸鱼娘」的复制件。

## 为什么不直接打包 dsh-pet 的动画

[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 代码是 MIT，但其**宠物形象与动画素材**声明为：

> [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名 · 非商业 · 相同方式共享）  
> 形象出处：社区二创「大肥鱼」，原型「溟月」等，**禁止任何形式商业化**。

把那些 webm / 设定图拷进本仓库会传染 NC-SA 义务，也违反作者声明。因此：

- **不** vendoring `dsh-pet/assets/**`
- **不** 改绘同人成图当默认皮肤

## 合法复用方式（推荐）

用户自行安装 `dsh-pet` 后，本插件探测 `/dsh-pet-7340/state`：

1. 默认隐藏自绘 SVG，**不另开对话框**；对话用 dsh-pet 自带的（悬停按 `L` / `Ctrl+Shift+L`）；
2. 桌宠形象与动画由 **dsh-pet 自己渲染**；
3. Host 轮询其 `/chat`：用户说到看屏时抓帧，带锁 `/broadcast`；右键「更多」可挂 **小瞥急停**。

未装 dsh-pet 时可切回「形象：内置」。
