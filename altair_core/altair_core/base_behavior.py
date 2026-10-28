import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
import time
import json
import os

# メッセージ・サービス定義
from altair_interfaces.msg import MddFeedback, MddCommand, ServoCommand, SolenoidCommand
from altair_interfaces.srv import TriggerControl
from std_msgs.msg import String

class GamepadState:
    """
    ゲームコントローラーの各スイッチやスティックの入力を変数として保持するクラス
    """
    def __init__(self):
        self.axes = [0.0] * 8
        self.buttons = [False] * 16

    def get_button(self, index):
        """指定インデックスのボタン状態 (True=ON, False=OFF) を取得します。"""
        if 0 <= index < len(self.buttons):
            return bool(self.buttons[index])
        return False

    def get_axis(self, index):
        """指定インデックスのアナログスティック軸状態 (-1.0〜1.0) を取得します。"""
        if 0 <= index < len(self.axes):
            return float(self.axes[index])
        return 0.0

class MddClient:
    """
    MDD (モータドライバ) の制御用簡易ラッパークラス
    """
    def __init__(self, node, name):
        self.node = node
        self.name = name
        self.latest_feedback = MddFeedback()

        # パブリッシャの作成
        self.cmd_pub = node.create_publisher(MddCommand, f"/altair/{name}/cmd", 10)
        
        # フィードバックの購読
        self.feedback_sub = node.create_subscription(
            MddFeedback, f"/altair/{name}/feedback", self._feedback_callback, 10,
            callback_group=node.callback_group
        )

    def _feedback_callback(self, msg):
        self.latest_feedback = msg

    def set_targets(self, targets):
        """
        4つのモータの目標値を設定します。
        targets: [m1, m2, m3, m4] (floatの配列。単位はモードに応じる)
        """
        msg = MddCommand()
        msg.targets = [float(t) for t in targets]
        self.cmd_pub.publish(msg)

    def get_feedback(self):
        """
        最新のフィードバックメッセージを返します。
        返り値: MddFeedback 型
        """
        return self.latest_feedback


class ServoClient:
    """
    Servo (6ch サーボモジュール) の制御用簡易ラッパークラス
    """
    def __init__(self, node, name):
        self.node = node
        self.name = name
        self.cmd_pub = node.create_publisher(ServoCommand, f"/altair/{name}/cmd", 10)

    def set_angles(self, angles):
        """
        6チャネルのサーボの目標角度を設定します。
        angles: [s1, s2, s3, s4, s5, s6] (0〜180度)
        """
        msg = ServoCommand()
        msg.angles = [int(a) for a in angles]
        self.cmd_pub.publish(msg)


class SolenoidClient:
    """
    Solenoid Valve (12ch 電磁弁) の制御用簡易ラッパークラス
    """
    def __init__(self, node, name):
        self.node = node
        self.name = name
        self.valves_state = [False] * 12
        self.cmd_pub = node.create_publisher(SolenoidCommand, f"/altair/{name}/cmd", 10)

    def set_valves(self, valves):
        """
        12チャネルの電磁弁のON/OFFを一括で設定します。
        valves: boolの12要素配列 (True=ON, False=OFF)
        """
        self.valves_state = [bool(v) for v in valves]
        msg = SolenoidCommand()
        msg.valves = self.valves_state
        self.cmd_pub.publish(msg)

    def set_valve(self, channel, state):
        """
        特定のチャネルの電磁弁のON/OFFを設定します。
        channel: 1〜12
        state: True (ON) または False (OFF)
        """
        if 1 <= channel <= 12:
            self.valves_state[channel - 1] = bool(state)
            self.set_valves(self.valves_state)


class AltairBehavior(Node):
    """
    すべてのユーザー動作プログラム（Behavior）のベースとなるROS2ノードクラス。
    ユーザーやAIは、このクラスを継承して on_init() や loop() をオーバーライドします。
    """
    def __init__(self, node_name="user_behavior_node"):
        super().__init__(node_name)
        self.callback_group = ReentrantCallbackGroup()
        self._module_clients = {}
        
        # 設定のロード
        self.config = self._load_config()

        # ゲームコントローラー状態の自動購読
        self.gamepad = GamepadState()
        self.gamepad_sub = self.create_subscription(
            String, '/altair/gamepad/state', self._gamepad_callback, 10,
            callback_group=self.callback_group
        )

        # 派生クラスの初期化
        self.on_init()
        self.get_logger().info(f"動作プログラム {node_name} が初期化されました。")

    def _gamepad_callback(self, msg):
        try:
            data = json.loads(msg.data)
            self.gamepad.axes = data.get("axes", [])
            self.gamepad.buttons = data.get("buttons", [])
        except Exception:
            pass

    def _load_config(self):
        # 設定ファイルの探索
        paths = [
            "c:/Users/106no/Documents/GitHub/altair_framework/altair_core/config/modules_config.json",
            os.path.join(os.path.expanduser('~'), 'ros2_ws/install/altair_core/share/altair_core/config/modules_config.json'),
            "./src/altair_framework/altair_core/config/modules_config.json",
            "modules_config.json"
        ]
        for p in paths:
            if os.path.exists(p):
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        return json.load(f)
                except:
                    pass
        return {"modules": []}

    def get_module(self, name):
        """
        モジュール名から、そのモジュールを操作するための簡易クライアントを取得します。
        """
        if name in self._module_clients:
            return self._module_clients[name]

        # 設定からモジュールタイプを特定
        mtype = None
        for module in self.config.get('modules', []):
            if module['name'] == name:
                mtype = module['type']
                break

        if not mtype:
            self.get_logger().error(f"設定ファイル内にモジュール名 '{name}' が見つかりませんでした。")
            raise ValueError(f"Module '{name}' not found in configuration.")

        # クライアントオブジェクトの生成
        if mtype == 'mdd':
            client = MddClient(self, name)
        elif mtype == 'servo':
            client = ServoClient(self, name)
        elif mtype == 'solenoid':
            client = SolenoidClient(self, name)
        else:
            self.get_logger().error(f"未知のモジュールタイプ: '{mtype}'")
            raise ValueError(f"Unknown module type '{mtype}'")

        self._module_clients[name] = client
        return client

    def request_start_control(self, timeout_sec=2.0):
        """
        モジュールマネージャーにパラメータ送信および制御モード遷移を要求します。
        Behavior起動時や待機状態からの自動復帰に使用します。
        """
        if not hasattr(self, '_start_control_cli'):
            self._start_control_cli = self.create_client(
                TriggerControl, '/altair/start_control',
                callback_group=self.callback_group
            )

        if not self._start_control_cli.wait_for_service(timeout_sec=timeout_sec):
            self.get_logger().warn("制御開始サービス '/altair/start_control' が見つかりません。")
            return False

        req = TriggerControl.Request()
        future = self._start_control_cli.call_async(req)
        
        # コールバックグループがReentrantのため、完了まで少し待機
        start_t = time.monotonic()
        while not future.done() and (time.monotonic() - start_t < timeout_sec):
            time.sleep(0.01)

        if future.done():
            res = future.result()
            if res and res.success:
                self.get_logger().info(f"制御開始要求が受理されました: {res.message}")
                return True
            else:
                msg = res.message if res else "レスポンスなし"
                self.get_logger().warn(f"制御開始要求が失敗しました: {msg}")
                return False
        else:
            self.get_logger().warn("制御開始要求がタイムアウトしました。")
            return False

    def on_init(self):
        """
        動作の初期化処理（派生クラスでオーバーライドします）
        """
        pass

    def loop(self):
        """
        周期実行される動作処理（派生クラスでオーバーライドします）
        """
        pass

    def run(self, rate_hz=500.0):
        """
        動作プログラムの周期実行ループを開始します。
        rate_hz: 周期の周波数で、デフォルトは500 Hzです。
        """
        self.timer = self.create_timer(
            1.0 / rate_hz, self.loop,
            callback_group=self.callback_group
        )
        
        # マルチスレッドエグゼキュータを使用して非同期通信とループを両立
        self._ros_executor = rclpy.executors.MultiThreadedExecutor()
        self._ros_executor.add_node(self)
        
        try:
            self.get_logger().info(f"周期実行ループを開始します (周波数: {rate_hz} Hz)...")
            self._ros_executor.spin()
        except KeyboardInterrupt:
            pass
        finally:
            self.destroy_node()
