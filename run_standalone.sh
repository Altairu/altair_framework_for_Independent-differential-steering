#!/bin/bash
# ==========================================
# Altair Framework - 単一PC運用 (スタンドアロン) 一括起動スクリプト
# ==========================================
# ロボット搭載PCの1台ですべてのノード (CANブリッジ, 制御マネージャー,
# 自律動作ランナー, Webサーバー) を一括起動します。

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

USE_USB=0
TARGET_IP="192.168.2.123"
TARGET_PORT="5000"
CAN_CHANNEL="can1"

show_help() {
    cat << 'EOF'
使用方法: ./run_standalone.sh [オプション]

オプション:
  --eth              Ethernet-CAN 変換モジュールを使用 (推奨 / デフォルト)
  --usb              従来の USB-to-CAN (slcand) を使用 (非推奨)
  --ip <IPアドレス>  Ethernet-CAN のIPアドレスを指定 (初期値: 192.168.2.123)
  --port <ポート>    Ethernet-CAN のポート番号を指定 (初期値: 5000)
  --channel <ch>     CANチャンネルを指定: can1 / can2 / both (初期値: can1)
  -h, --help         このヘルプを表示
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --usb)
            USE_USB=1
            shift
            ;;
        --eth)
            USE_USB=0
            shift
            ;;
        --ip)
            TARGET_IP="$2"
            shift 2
            ;;
        --port)
            TARGET_PORT="$2"
            shift 2
            ;;
        --channel)
            CAN_CHANNEL="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "不明なオプションです: $1"
            show_help
            exit 1
            ;;
    esac
done

echo "====== Altair Framework: Starting Standalone System (Single PC) ======"

# 1. 実行ファイル存在チェック & ソース更新検知による自動ビルド
SHOULD_BUILD=0
if [ ! -f "install/setup.bash" ]; then
    SHOULD_BUILD=1
elif [ ! -f "install/altair_core/lib/altair_core/module_manager" ] || [ ! -f "install/altair_web_server/lib/altair_web_server/web_server_node" ]; then
    SHOULD_BUILD=1
elif [ "$USE_USB" -eq 1 ] && [ ! -f "install/altair_can_bridge/lib/altair_can_bridge/can_bridge_node" ]; then
    SHOULD_BUILD=1
elif [ "$USE_USB" -eq 0 ] && [ ! -f "install/altair_eth_can_bridge/lib/altair_eth_can_bridge/eth_can_bridge_node" ]; then
    SHOULD_BUILD=1
elif [ "$USE_USB" -eq 0 ] && [ "altair_eth_can_bridge/src/eth_can_bridge_node.cpp" -nt "install/altair_eth_can_bridge/lib/altair_eth_can_bridge/eth_can_bridge_node" ]; then
    SHOULD_BUILD=1
elif [ "$USE_USB" -eq 1 ] && [ "altair_can_bridge/src/can_bridge_node.cpp" -nt "install/altair_can_bridge/lib/altair_can_bridge/can_bridge_node" ]; then
    SHOULD_BUILD=1
fi

if [ "$SHOULD_BUILD" -eq 1 ]; then
    echo "[WARNING] ワークスペースをビルドまたは再ビルドします..."
    ./build.sh
    if [ $? -ne 0 ]; then
        echo "[ERROR] ビルド失敗のため起動を中止します。"
        exit 1
    fi
fi

if [ -f "/opt/ros/humble/setup.bash" ]; then
    source /opt/ros/humble/setup.bash
fi
source install/setup.bash

export ROS_DOMAIN_ID=0

# 2. シグナルトラップの設定 (Ctrl+C時に全バックグラウンドプロセスを安全にキル)
cleanup() {
    echo "バックグラウンドノードを安全に終了しています..."
    kill $PID_BRIDGE $PID_MGR $PID_RUNNER 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# 3. CANブリッジノードをバックグラウンドで起動
if [ "$USE_USB" -eq 1 ]; then
    echo "1. USB-to-CAN ブリッジノードを起動中..."
    ros2 run altair_can_bridge can_bridge_node &
    PID_BRIDGE=$!
else
    echo "1. Ethernet-CAN ブリッジノードを起動中 (${TARGET_IP}:${TARGET_PORT})..."
    ros2 run altair_eth_can_bridge eth_can_bridge_node \
        --ros-args \
        -p target_ip:="${TARGET_IP}" \
        -p target_port:=${TARGET_PORT} \
        -p can_channel:="${CAN_CHANNEL}" &
    PID_BRIDGE=$!
fi
sleep 1

# 4. Module Manager をバックグラウンドで起動
echo "2. Module Manager を起動中..."
ros2 run altair_core module_manager &
PID_MGR=$!
sleep 1

# 5. Behavior Runner をバックグラウンドで起動
echo "3. Behavior Runner を起動中..."
ros2 run altair_core behavior_runner &
PID_RUNNER=$!
sleep 1

# 6. Web Server / Dashboard UI をフォアグラウンドで起動
echo "4. Web Server & Dashboard をポート8000で起動中..."

# マシンのIPアドレスを自動検出 (WiFi/有線問わずLAN側IPを取得)
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$HOST_IP" ]; then
    HOST_IP=$(ip -4 addr show scope global 2>/dev/null | grep inet | awk '{print $2}' | cut -d/ -f1 | head -n 1)
fi
if [ -z "$HOST_IP" ]; then
    HOST_IP="localhost"
fi

echo "同じネットワークのPCやスマホのブラウザからアクセスできます:"
echo "👉 http://${HOST_IP}:8000/"
echo "====================================================="

ros2 run altair_web_server web_server_node

cleanup
