#!/bin/bash
# ==========================================
# Altair Framework - NUCロボット側 起動スクリプト
# ==========================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

USE_USB=0
TARGET_IP="192.168.2.123"
TARGET_PORT="5000"
CAN_CHANNEL="can1"

show_help() {
    cat << 'EOF'
使用方法: ./run_nuc.sh [オプション]

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

echo "====== Altair Framework: Starting NUC CAN Bridge Node ======"

# 1. ビルド存在チェック & ソース更新検知による自動ビルド
SHOULD_BUILD=0
if [ ! -f "install/setup.bash" ]; then
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

# 2. 指定されたブリッジノードの実行
if [ "$USE_USB" -eq 1 ]; then
    echo "[INFO] 従来の USB-to-CAN (SocketCAN) ブリッジノードを起動します..."
    ros2 run altair_can_bridge can_bridge_node
else
    echo "[INFO] Ethernet-CAN ブリッジノードを起動します (接続先: ${TARGET_IP}:${TARGET_PORT}, チャンネル: ${CAN_CHANNEL})..."
    ros2 run altair_eth_can_bridge eth_can_bridge_node \
        --ros-args \
        -p target_ip:="${TARGET_IP}" \
        -p target_port:=${TARGET_PORT} \
        -p can_channel:="${CAN_CHANNEL}"
fi
