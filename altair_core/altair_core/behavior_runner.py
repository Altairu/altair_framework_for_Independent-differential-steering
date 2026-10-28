import os
import signal
import subprocess
import sys
import threading
import time
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup

# ROS2 メッセージ ＆ サービス
from std_msgs.msg import String
from std_srvs.srv import Trigger
from altair_interfaces.srv import StartBehavior

class BehaviorRunner(Node):
    def __init__(self):
        super().__init__('behavior_runner')
        self.callback_group = ReentrantCallbackGroup()

        # パブリッシャ
        self.log_pub = self.create_publisher(String, '/altair/behavior/log', 10)
        self.status_pub = self.create_publisher(String, '/altair/behavior/status', 10)

        # サービスサーバー
        self.start_srv = self.create_service(
            StartBehavior, '/altair/behavior/start', self.handle_start_behavior_service,
            callback_group=self.callback_group
        )
        self.stop_srv = self.create_service(
            Trigger, '/altair/behavior/stop', self.handle_stop_behavior_service,
            callback_group=self.callback_group
        )

        # メンバー変数
        self.current_process = None
        self.process_thread = None
        self.status = "IDLE"  # IDLE, RUNNING, STOPPING, ERROR
        self.active_behavior_name = ""

        # ステータス配信用のタイマー (1Hz)
        self.status_timer = self.create_timer(
            1.0, self.publish_status,
            callback_group=self.callback_group
        )

        self.get_logger().info("Behavior Runner ノードが正常に起動しました。動作スクリプトの実行待ちです。")

    def publish_status(self):
        """
        現在のステータスをパブリッシュする
        """
        msg = String()
        if self.status == "RUNNING":
            msg.data = f"RUNNING ({self.active_behavior_name})"
        else:
            msg.data = self.status
        self.status_pub.publish(msg)

    # --- 動作スクリプトの起動 ---
    def handle_start_behavior_service(self, request, response):
        behavior_name = request.behavior_name
        self.get_logger().info(f"動作スクリプト起動要求を受信: {behavior_name}")

        if self.current_process is not None:
            self.get_logger().warn("すでに別の動作スクリプトが実行中です。終了させてから起動します。")
            self.stop_current_behavior()

        # スクリプトのフルパスを決定
        script_path = self.get_script_path(behavior_name)
        if not os.path.exists(script_path):
            self.get_logger().error(f"指定された動作プログラムが見つかりませんでした: {script_path}")
            response.success = False
            response.message = f"ファイルが見つかりません: {behavior_name}"
            self.status = "ERROR"
            return response

        try:
            # 動作プログラムを別プロセスとして起動 (グループリーダー化して子孫プロセスもキル可能にする)
            self.current_process = subprocess.Popen(
                ["python3", script_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # 標準エラーも標準出力にマージしてキャプチャ
                text=True,
                preexec_fn=os.setsid  # Linux上で新しいプロセスグループを作成
            )

            self.status = "RUNNING"
            self.active_behavior_name = behavior_name

            # ログ読み取り用の非同期スレッドを起動
            self.process_thread = threading.Thread(
                target=self.log_reader_loop, 
                args=(self.current_process, behavior_name)
            )
            self.process_thread.daemon = True
            self.process_thread.start()

            response.success = True
            response.message = f"動作スクリプト {behavior_name} を正常に起動しました。"
            self.get_logger().info(f"動作スクリプト {behavior_name} を起動しました (PID: {self.current_process.pid})")
        
        except Exception as e:
            self.get_logger().error(f"プロセスの起動に失敗しました: {str(e)}")
            response.success = False
            response.message = f"起動失敗: {str(e)}"
            self.status = "ERROR"
            self.current_process = None

        return response

    def get_script_path(self, name):
        """
        動作スクリプトファイルの絶対パスを決定する
        優先: user_behaviors/ > altair_core/user_behaviors/
        """
        paths = [
            # 0. user_behaviors/ ディレクトリを最優先
            f"user_behaviors/{name}",
            f"./user_behaviors/{name}",
            # 1. ワークスペースのローカルソースパス
            f"c:/Users/106no/Documents/GitHub/altair_framework/user_behaviors/{name}",
            # 2. ROS2シェアディレクトリ
            os.path.join(os.path.expanduser('~'), f"ros2_ws/src/altair_framework/user_behaviors/{name}"),
            # 3. 相対パスフォールバック
            f"./src/altair_framework/user_behaviors/{name}",
            # 4. 旧パス (後方互換性)
            f"c:/Users/106no/Documents/GitHub/altair_framework/altair_core/user_behaviors/{name}",
            os.path.join(os.path.expanduser('~'), f"ros2_ws/src/altair_framework/altair_core/user_behaviors/{name}"),
            f"./src/altair_framework/altair_core/user_behaviors/{name}"
        ]
        for p in paths:
            if os.path.exists(p):
                return p
        # すべてのパス探索失敗時は、user_behaviors/ を返す
        return f"user_behaviors/{name}"

    # --- 動作スクリプトの停止 ---
    def handle_stop_behavior_service(self, request, response):
        # 未使用の引数を明示的に無視
        _ = request
        self.get_logger().info("動作スクリプト停止要求を受信しました。")
        
        if self.current_process is None:
            response.success = True
            response.message = "動作スクリプトは実行されていません。"
            return response

        success = self.stop_current_behavior()
        response.success = success
        if success:
            response.message = "動作スクリプトを正常に停止しました。"
        else:
            response.message = "動作スクリプトの強制停止に失敗しました。"
        
        return response

    def stop_current_behavior(self):
        """
        現在実行中のプロセスを安全にキルする
        """
        proc = self.current_process
        if proc is None:
            return True

        self.status = "STOPPING"
        self.get_logger().info(f"プロセスグループ {proc.pid} に停止信号 (SIGINT) を送信します...")

        try:
            # プロセスグループ全体に SIGINT (Ctrl+C) を送信
            os.killpg(os.getpgid(proc.pid), signal.SIGINT)
            
            # 最大 3秒 安全な終了を待つ
            for _ in range(30):
                if proc.poll() is not None:
                    break
                time.sleep(0.1)

            # まだ終了していなければ強制終了 (SIGKILL)
            if proc.poll() is None:
                self.get_logger().warn("プロセスが安全に終了しなかったため、強制終了 (SIGKILL) します。")
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                proc.wait()

            self.get_logger().info("プロセスは正常に終了しました。")
            self.current_process = None
            self.process_thread = None
            self.status = "IDLE"
            self.active_behavior_name = ""
            return True

        except Exception as e:
            self.get_logger().error(f"プロセスのキル中に例外が発生しました: {str(e)}")
            self.status = "ERROR"
            return False

    # --- ログの読み取りスレッドループ ---
    def log_reader_loop(self, process, behavior_name):
        """
        サブプロセスの標準出力をリアルタイムで1行ずつ読み取り、ROS2トピックに配信する
        """
        # 起動の目印ログを送信
        start_log = String()
        start_log.data = f"--- STARTING BEHAVIOR: {behavior_name} ---"
        self.log_pub.publish(start_log)

        for line in iter(process.stdout.readline, ""):
            # 各行を配信
            log_msg = String()
            log_msg.data = line.rstrip()
            self.log_pub.publish(log_msg)
            
            # デバッグ用にノードのロガーにも出力
            self.get_logger().info(f"[{behavior_name}] {line.rstrip()}")

        # プロセス終了を待って後片付け
        process.wait()
        exit_code = process.returncode
        
        # 終了の目印ログを送信
        end_log = String()
        end_log.data = f"--- BEHAVIOR EXITED WITH CODE: {exit_code} ---"
        self.log_pub.publish(end_log)

        # 外部からキルされたのでなく、自立終了した場合の後処理
        if self.current_process == process:
            self.current_process = None
            self.process_thread = None
            self.status = "IDLE"
            self.active_behavior_name = ""

def main(args=None):
    rclpy.init(args=args)
    node = BehaviorRunner()
    
    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        # 終了時に必ずプロセスを殺す
        node.stop_current_behavior()
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
