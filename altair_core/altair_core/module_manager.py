import json
import os
import struct
import time
from pathlib import Path
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from std_srvs.srv import Trigger
from ament_index_python.packages import PackageNotFoundError, get_package_share_directory

# ROS2 標準 ＆ カスタムメッセージ
from std_msgs.msg import String
from can_msgs.msg import Frame
from altair_interfaces.msg import MddFeedback, MddCommand, ServoCommand, SolenoidCommand
from altair_interfaces.srv import TriggerControl

class ModuleManager(Node):
    def __init__(self):
        super().__init__('module_manager')
        self.callback_group = ReentrantCallbackGroup()

        # パブリッシャ: CAN送信用のトピック
        self.can_tx_pub = self.create_publisher(Frame, '/altair/can/tx', 100)

        # サブスクライバ: NUCからのCAN受信用のトピック
        self.can_rx_sub = self.create_subscription(
            Frame, '/altair/can/rx', self.handle_can_rx_callback, 100,
            callback_group=self.callback_group
        )

        # サブスクライバ: 構成ファイル同期用トピック
        self.config_sync_sub = self.create_subscription(
            String, '/altair/config_sync', self.handle_config_sync_callback, 10,
            callback_group=self.callback_group
        )

        # サービスサーバー: パラメータ送信トリガー
        self.trigger_srv = self.create_service(
            TriggerControl, '/altair/start_control', self.handle_start_control_service,
            callback_group=self.callback_group
        )

        # サービスサーバー: 設定ファイルリロードトリガー
        self.reload_srv = self.create_service(
            Trigger, '/altair/reload_config', self.handle_reload_config_service,
            callback_group=self.callback_group
        )

        # 動的生成したパブリッシャ/サブスクライバの保持用ディクショナリ
        self.publishers_dict = {}
        self.subscriptions_dict = {}
        
        # モータごとの最新フィードバックデータをキャッシュする（角度と速度を1つのトピックに統合するため）
        self.mdd_feedback_cache = {}

        # 指令値キャッシュ（10msの周期送信タイマーで使用する最新の目標値）
        self.mdd_targets = {}
        self.servo_angles = {}
        self.solenoid_valves = {}

        # 制御システムの状態 (False = パラメータ送信待ち, True = 制御実行中)
        self.is_running = False
        # パラメータ送信中フラグ（パラメータ送信中に周期コマンドが割り込むのを防ぐ）
        self.is_sending_params = False
        # 制御開始時刻（モード遷移直後の古いキャッシュや遷移中の0x230フレームによる誤リセットを防ぐ猶予期間用）
        self.control_start_monotonic = 0.0

        # 設定ファイルのロードと動的初期化
        self.load_config_and_initialize()

        # 10ms周期のCANコマンド送信タイマー (100Hz: マイコンの制御周期およびEthernet-CANの1msポーリングに適合)
        self.control_timer = self.create_timer(
            0.01, self.publish_all_control_commands,
            callback_group=self.callback_group
        )

        self.get_logger().info("Module Manager ノードが起動しました。初期設定ロード完了。")

    def load_config_and_initialize(self):
        """
        config/modules_config.json をロードし、動的トピックを構築する
        """
        # 一旦既存の動的トピックをクリア
        for sub in self.subscriptions_dict.values():
            self.destroy_subscription(sub)
        for pub in self.publishers_dict.values():
            self.destroy_publisher(pub)
        
        self.publishers_dict.clear()
        self.subscriptions_dict.clear()
        self.mdd_feedback_cache.clear()

        # パッケージのシェアディレクトリまたはローカルパスからロード
        config_path = self.get_config_path()
        self.get_logger().info(f"設定ファイルをロード中: {config_path}")

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)
        except Exception as e:
            self.get_logger().error(f"設定ファイルの読み込みに失敗しました: {str(e)}")
            return

        # 各モジュールをループ処理して動的トピックを作成
        for module in self.config.get('modules', []):
            name = module['name']
            mtype = module['type']
            base_id = int(module['base_id'], 16)

            self.get_logger().info(f"モジュールを登録: {name} (タイプ: {mtype}, BaseID: {hex(base_id)})")

            if mtype == 'mdd':
                # 指令キャッシュ初期化
                self.mdd_targets[name] = [0.0, 0.0, 0.0, 0.0]

                # MDDモータ指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    MddCommand, topic_name,
                    self.make_mdd_cmd_callback(name), 10,
                    callback_group=self.callback_group
                )
                
                # MDDフィードバック用パブリッシャ
                feedback_topic = f"/altair/{name}/feedback"
                self.publishers_dict[feedback_topic] = self.create_publisher(
                    MddFeedback, feedback_topic, 10
                )

                # フィードバック用キャッシュの初期化
                self.mdd_feedback_cache[base_id] = {
                    'limit_switches': [False, False, False, False],
                    'error_code': 0,
                    'system_status': 0,
                    'angles': [0.0, 0.0, 0.0, 0.0],
                    'speeds': [0.0, 0.0, 0.0, 0.0]
                }

            elif mtype == 'servo':
                # 指令キャッシュ初期化
                self.servo_angles[name] = [90, 90, 90, 90, 90, 90]

                # サーボ指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    ServoCommand, topic_name,
                    self.make_servo_cmd_callback(name), 10,
                    callback_group=self.callback_group
                )

            elif mtype == 'solenoid':
                # 指令キャッシュ初期化
                self.solenoid_valves[name] = [False] * 12

                # 電磁弁指令用サブスクライバ
                topic_name = f"/altair/{name}/cmd"
                self.subscriptions_dict[topic_name] = self.create_subscription(
                    SolenoidCommand, topic_name,
                    self.make_solenoid_cmd_callback(name), 10,
                    callback_group=self.callback_group
                )

    def get_config_path(self):
        """
        モジュール構成ファイルの絶対パスを探索して返す
        """
        candidates = []

        # 明示指定があれば最優先
        env_path = os.getenv('ALTAIR_MODULES_CONFIG')
        if env_path:
            candidates.append(Path(env_path).expanduser())

        # ROS2インストール先 (share/altair_core/config)
        try:
            share_dir = Path(get_package_share_directory('altair_core'))
            candidates.append(share_dir / 'config' / 'modules_config.json')
        except PackageNotFoundError:
            pass

        # 開発時の代表的な相対パス
        cwd = Path.cwd()
        candidates.append(cwd / 'altair_core' / 'config' / 'modules_config.json')
        candidates.append(cwd / 'config' / 'modules_config.json')

        # モジュールファイル基準の相対パス
        this_file = Path(__file__).resolve()
        candidates.append(this_file.parent.parent / 'config' / 'modules_config.json')

        # build/配下のモジュールから実行された場合のフォールバック
        if len(this_file.parents) >= 5:
            candidates.append(this_file.parents[4] / 'altair_core' / 'config' / 'modules_config.json')

        for path in candidates:
            if path.exists():
                return str(path)

        # 見つからない場合は先頭候補を返して、呼び出し側のエラーログに実パスを出す
        return str(candidates[0]) if candidates else 'config/modules_config.json'

    # --- 1. コールバック処理 (目標値のキャッシュ更新) ---
    def make_mdd_cmd_callback(self, name):
        def callback(msg):
            self.mdd_targets[name] = [float(t) for t in msg.targets]
        return callback

    def make_servo_cmd_callback(self, name):
        def callback(msg):
            self.servo_angles[name] = [int(a) for a in msg.angles]
        return callback

    def make_solenoid_cmd_callback(self, name):
        def callback(msg):
            self.solenoid_valves[name] = [bool(v) for v in msg.valves]
        return callback

    # --- 2. 10ms周期 CANコマンド一括送信タイマー (100Hz) ---
    def publish_all_control_commands(self):
        """
        登録されているすべてのモジュールに対して、最新の指令値を10ms（100Hz）周期でCANバスへ送信する
        """
        # パラメータ送信中は設定フレームの上書きを防ぐため周期送信を一時停止する
        if self.is_sending_params:
            return

        for module in self.config.get('modules', []):
            name = module['name']
            mtype = module['type']
            base_id = int(module['base_id'], 16)

            if mtype == 'mdd':
                # 制御実行中(is_running == True)でないときは、不要なバス負荷と上書きを避けるため0x220を送信しない
                if not self.is_running:
                    continue
                targets = self.mdd_targets.get(name, [0.0, 0.0, 0.0, 0.0])

                cmd_id = base_id + 0x20  # 例: 0x220
                try:
                    targets_int = [max(-32768, min(32767, int(t * 10))) for t in targets]
                    payload = struct.pack('<hhhh', *targets_int)
                except Exception as e:
                    self.get_logger().error(f"MDD目標値の周期エンコード失敗 ({name}): {str(e)}")
                    continue

                frame = Frame()
                frame.header.stamp = self.get_clock().now().to_msg()
                frame.id = cmd_id
                frame.dlc = 8
                frame.is_extended = False
                frame.is_rtr = False
                frame.data = list(payload)
                self.can_tx_pub.publish(frame)

            elif mtype == 'servo':
                # サーボはいつでも最新の指令値（デフォルト90度）を常に10msで送信
                angles = self.servo_angles.get(name, [90, 90, 90, 90, 90, 90])
                payload = list(angles[:6])
                payload = [min(a, 180) for a in payload]
                while len(payload) < 6:
                    payload.append(90)

                frame = Frame()
                frame.header.stamp = self.get_clock().now().to_msg()
                frame.id = base_id  # 通常 0x100
                frame.dlc = 6
                frame.is_extended = False
                frame.is_rtr = False
                frame.data = payload + [0]*(8-len(payload))
                self.can_tx_pub.publish(frame)

            elif mtype == 'solenoid':
                # 電磁弁も常に最新のON/OFF状態を10msで送信
                valves = self.solenoid_valves.get(name, [False] * 12)
                byte0 = 0
                byte1 = 0
                for i in range(min(len(valves), 12)):
                    if valves[i]:
                        if i < 8:
                            byte0 |= (1 << i)
                        else:
                            byte1 |= (1 << (i - 8))

                frame = Frame()
                frame.header.stamp = self.get_clock().now().to_msg()
                frame.id = base_id  # 通常 0x300
                frame.dlc = 2
                frame.is_extended = False
                frame.is_rtr = False
                frame.data = [byte0, byte1] + [0]*6
                self.can_tx_pub.publish(frame)

    # --- 3. CAN ➔ ROS2 フィードバック変換処理 (NUC ➔ PC) ---
    def handle_can_rx_callback(self, frame):
        can_id = frame.id
        # self.get_logger().info(f"[CAN_RX] ID: {hex(can_id)}, DLC: {frame.dlc}, Data: {list(frame.data)}")

        try:
            # 現在キャッシュに登録されているMDD Base IDを走査
            for base_id, cache in self.mdd_feedback_cache.items():
                # A. ステータス返信 (Base ID + 0x30 = 0x230)
                if can_id == (base_id + 0x30):
                    if frame.dlc < 6:
                        continue
                    data = bytes(frame.data[:6])
                    # アンパック (Limit SW1-4, Error Code, System Status)
                    cache['limit_switches'] = [bool(b) for b in data[0:4]]
                    cache['error_code'] = data[4]

                    in_grace_period = (time.monotonic() - self.control_start_monotonic) < 1.2
                    if data[5] == 0 and self.is_running and in_grace_period:
                        # 制御開始直後の遷移猶予期間中は、古い待機ステータス(0)による誤リセットを防ぐ
                        cache['system_status'] = 1
                    else:
                        cache['system_status'] = data[5]
                    
                    # マイコンが待機状態（0）にリセットされたことを検知したら、PC側の制御フラグも安全のために即座にFalseに戻す
                    if data[5] == 0 and self.is_running and not in_grace_period:
                        self.is_running = False
                        module_name = ""
                        for module in self.config.get('modules', []):
                            if int(module['base_id'], 16) == base_id:
                                module_name = module['name']
                                break
                        self.get_logger().warn(f"マイコン '{module_name}' の待機状態へのリセットを検知したため、PC側の制御フラグを安全にリセットしました。")
                    
                    self.publish_mdd_feedback(base_id)

                # B. エンコーダ角度 (Base ID + 0x40 = 0x240)
                elif can_id == (base_id + 0x40):
                    if frame.dlc < 8:
                        continue
                    # int16_t * 4 のデコード (リトルエンディアン)
                    angles_raw = struct.unpack('<hhhh', bytes(frame.data[:8]))
                    # 0.1 deg 単位を度(degree)に変換
                    cache['angles'] = [float(a) / 10.0 for a in angles_raw]
                    
                    self.publish_mdd_feedback(base_id)

                # C. エンコーダ回転速度 (Base ID + 0x50 = 0x250)
                elif can_id == (base_id + 0x50):
                    if frame.dlc < 8:
                        continue
                    # int16_t * 4 のデコード
                    speeds_raw = struct.unpack('<hhhh', bytes(frame.data[:8]))
                    # 0.01 rps 単位を rps に変換
                    cache['speeds'] = [float(s) / 100.0 for s in speeds_raw]
                    
                    self.publish_mdd_feedback(base_id)
        except Exception as e:
            self.get_logger().error(f"CAN受信コールバック処理中にエラーが発生しました: {str(e)}")

    def publish_mdd_feedback(self, base_id):
        """
        キャッシュされたMDDフィードバックデータを結合してROS2トピックに配信する
        """
        # base_idに対応するモジュール名を探す
        module_name = ""
        for module in self.config.get('modules', []):
            if int(module['base_id'], 16) == base_id:
                module_name = module['name']
                break
        
        if not module_name:
            return

        cache = self.mdd_feedback_cache[base_id]
        
        msg = MddFeedback()
        msg.limit_switches = cache['limit_switches']
        msg.error_code = cache['error_code']
        msg.system_status = cache['system_status']
        msg.angles = cache['angles']
        msg.speeds = cache['speeds']

        topic_name = f"/altair/{module_name}/feedback"
        if topic_name in self.publishers_dict:
            self.publishers_dict[topic_name].publish(msg)

    # --- 5. パラメータ送信 ＆ 制御実行モード遷移トリガーサービス ---
    def handle_start_control_service(self, request, response):
        # 未使用の引数を明示的に無視
        _ = request
        self.get_logger().info("スタート制御要求を受信しました。パラメータの送信を開始します。")

        self.is_sending_params = True
        try:
            # 構成ファイル内のすべてのmddモジュールに対してパラメータを順次送信
            for module in self.config.get('modules', []):
                if module['type'] != 'mdd':
                    continue

                base_id = int(module['base_id'], 16)
                params = module.get('parameters', {})

                # 4つのモータ (m1〜m4) のゲイン・直径・方向を送信
                for idx, motor_key in enumerate(['m1', 'm2', 'm3', 'm4']):
                    m_param = params.get(motor_key, {"p": 1.0, "i": 0.0, "d": 0.0, "diameter": 100.0, "direction": 1})
                    
                    p_gain = int(float(m_param.get('p', 1.0)) * 1000)
                    p_gain = max(-32768, min(32767, p_gain))
                    
                    i_gain = int(float(m_param.get('i', 0.0)) * 1000)
                    i_gain = max(-32768, min(32767, i_gain))
                    
                    d_gain = int(float(m_param.get('d', 0.0)) * 1000)
                    d_gain = max(-32768, min(32767, d_gain))
                    
                    # 直径に方向の符号をかける (例: 100 * 1 = 100, 100 * -1 = -100)
                    diameter = float(m_param.get('diameter', 100.0))
                    direction = float(m_param.get('direction', 1.0))
                    diameter_dir = int(diameter * direction)
                    diameter_dir = max(-32768, min(32767, diameter_dir))
                    
                    payload = struct.pack('<hhhh', p_gain, i_gain, d_gain, diameter_dir)
                    
                    # 送信先のCAN ID: 0x200 + モータインデックス (0x200, 0x201, 0x202, 0x203)
                    motor_id = base_id + idx
                    
                    frame = Frame()
                    frame.header.stamp = self.get_clock().now().to_msg()
                    frame.id = motor_id
                    frame.dlc = 8
                    frame.is_extended = False
                    frame.is_rtr = False
                    frame.data = list(payload)
                    self.can_tx_pub.publish(frame)
                    
                    self.get_logger().info(f"パラメータ送信: モータ{idx+1} (ID:{hex(motor_id)}) P={p_gain}, I={i_gain}, D={d_gain}, 車輪={diameter_dir}")
                    # Ethernet-CANおよびマイコン側の受信バッファ溢れを防ぐため遅延を挟む
                    time.sleep(0.025)

                # 4ch モード設定 (0x210) の送信
                modes = [
                    int(params.get('m1', {}).get('mode', 0)),
                    int(params.get('m2', {}).get('mode', 0)),
                    int(params.get('m3', {}).get('mode', 0)),
                    int(params.get('m4', {}).get('mode', 0))
                ]
                
                # Payload 4B: 各モータのモード (0=速度, 1=角度, 2=位置) を 8B にアライン
                mode_payload = modes + [0]*4
                
                mode_frame = Frame()
                mode_frame.header.stamp = self.get_clock().now().to_msg()
                mode_frame.id = base_id + 0x10  # 例: 0x210
                mode_frame.dlc = 4
                mode_frame.is_extended = False
                mode_frame.is_rtr = False
                mode_frame.data = mode_payload
                self.can_tx_pub.publish(mode_frame)
                
                self.get_logger().info(f"モード設定送信 (ID:{hex(base_id + 0x10)}): モード={modes}")
                time.sleep(0.025)

                # キャッシュ上のsystem_statusも一旦1（制御実行中）に更新して、直後の0x240/0x250受信で古い0が配信されるのを防ぐ
                if base_id in self.mdd_feedback_cache:
                    self.mdd_feedback_cache[base_id]['system_status'] = 1

            # 制御開始時刻を記録して制御実行中フラグをONにする
            self.control_start_monotonic = time.monotonic()
            self.is_running = True
            response.success = True
            response.message = "パラメータが正常に送信され、制御システムが実行状態に遷移しました。"
            self.get_logger().info("システムが『制御実行中』になりました。")
        
        except Exception as e:
            self.is_running = False
            response.success = False
            response.message = f"パラメータ送信中にエラーが発生しました: {str(e)}"
            self.get_logger().error(f"パラメータ送信エラー: {str(e)}")
        finally:
            self.is_sending_params = False

        return response

    def handle_reload_config_service(self, request, response):
        """
        設定ファイル更新時にトピックを動的再生成するサービスハンドラー
        """
        self.get_logger().info("モジュール設定のリロード要求を受信しました。トピックを再生成します。")
        try:
            self.load_config_and_initialize()
            response.success = True
            response.message = "モジュール構成を正常に再読み込みしました。"
        except Exception as e:
            response.success = False
            response.message = f"リロード失敗: {str(e)}"
            self.get_logger().error(f"リロード失敗: {str(e)}")
        return response

    def handle_config_sync_callback(self, msg):
        """
        WebServerから送信された最新のモジュール構成設定を受信し、
        NUC側の modules_config.json に上書き保存する
        """
        self.get_logger().info("モジュール構成同期メッセージを受信しました。")
        try:
            config_data = json.loads(msg.data)
            config_path = self.get_config_path()
            
            # ディレクトリの存在確認
            Path(config_path).parent.mkdir(parents=True, exist_ok=True)
            
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
                
            self.get_logger().info(f"NUC側の設定ファイルを同期保存しました: {config_path}")
        except Exception as e:
            self.get_logger().error(f"構成同期データの保存に失敗しました: {str(e)}")

def main(args=None):
    rclpy.init(args=args)
    node = ModuleManager()
    
    # ReentrantCallbackGroupを適切に動作させるため、MultiThreadedExecutorを使用
    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
