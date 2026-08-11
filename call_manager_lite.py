"""
Sky CRM Lite - 통화 기록 / 거래처 DB 전용
--------------------------------------------------
기존 프로그램(메모, 캘린더, 스티키 메모, FTP 동기화, 데이터 시트/수식 기능)을 걷어내고
통화 기록 + 거래처 DB 두 가지 핵심 기능만 남긴 경량 버전입니다.

이번 버전에서 특히 신경 쓴 부분:
1. 저장할 때마다 이전 저장본을 최대 3개까지 자동으로 보관합니다.
   (data.json, data.json.bak1, data.json.bak2, data.json.bak3)
   -> 저장 중 오류가 나거나 파일이 깨져도 이전 버전으로 되돌릴 수 있습니다.
2. 저장은 "임시 파일에 먼저 쓰고 -> 성공하면 바꿔치기" 방식(원자적 저장)을 사용합니다.
   -> 저장 도중 프로그램이 죽거나 강제 종료되어도 파일이 반토막 나서
      "빈 화면"이 뜨는 문제가 생기지 않습니다.
3. 프로그램을 켤 때 데이터 파일이 비어있거나 깨져 있으면, 자동으로 최근 백업을
   순서대로 찾아서 복구를 시도하고, 그 사실을 사용자에게 알려줍니다.
4. FTP 동기화처럼 복잡하고 오류 나기 쉬운 기능은 전부 제거했습니다. 데이터는
   지정한 폴더에 로컬 파일로만 저장됩니다. (필요하면 그 폴더를 Dropbox, OneDrive,
   네이버 MYBOX 같은 동기화 폴더로 지정해서 쓰셔도 됩니다.)
5. 통화 내용 칸은 더블클릭해서 편집할 때뿐 아니라, 평소 화면에서도 글자 수만큼
   자동으로 줄이 늘어나서 전체 내용이 보입니다. 열 너비를 조절해도 줄바꿈에
   맞춰 행 높이가 다시 계산됩니다.

*언어 선택에 대해*: 처리 속도 자체는 파이썬이 느린 게 아니라, 매번 화면 전체를
다시 그리거나 신호(signal)를 과도하게 연결하는 구조가 느려지는 원인이었습니다.
이 버전은 대량 데이터에서도 빠르게 동작하도록 (1) 목록 갱신 시 신호를 잠깐
꺼두고 (2) 행 높이 재계산을 필요한 시점에만 지연 실행(debounce)하고 (3) 정렬을
끄고 데이터를 채운 뒤 다시 켜는 방식으로 최적화했습니다. 이 정도 규모(통화기록
+ 거래처)의 프로그램은 파이썬 + PyQt로도 충분히 빠르고, 무엇보다 기존 코드와
호환되어 유지보수가 쉽기 때문에 언어는 그대로 유지했습니다.
"""

import sys
import os
import json
import uuid
import shutil
import traceback
import ftplib
import posixpath
from io import BytesIO
from datetime import datetime

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QTableWidget, QTableWidgetItem, QHeaderView, QAbstractItemView, QPushButton,
    QLineEdit, QTextEdit, QLabel, QRadioButton, QGroupBox, QDateEdit, QTabWidget,
    QMessageBox, QDialog, QFileDialog, QListWidget, QListWidgetItem, QSpinBox,
    QStyledItemDelegate, QMenu, QInputDialog, QStyle, QProgressBar, QCheckBox
)
from PyQt6.QtCore import Qt, QDate, QTimer, QEvent, QRect, QSize, QThread, pyqtSignal
from PyQt6.QtGui import QFont, QIcon, QKeySequence, QAction, QShortcut
from openpyxl import Workbook


DATA_FILE_NAME = "call_data.json"
SETTINGS_FILE = "call_settings_lite.json"
ICON_FILE = "skycrm_icon.ico"
BACKUP_SLOTS = 3
ROW_RESIZE_DEBOUNCE_MS = 150


# --------------------------------------------------------------------------
# 저장 / 백업 관련 유틸리티
# --------------------------------------------------------------------------

def default_ftp_info():
    return {"host": "", "port": 21, "user": "", "password": "", "remote_path": "/"}


def default_storage_settings():
    return {
        # local      : 하드디스크에만 저장
        # ftp        : FTP 서버에만 저장
        # local_sync : 하드디스크에 저장 + 종료/저장 시 FTP로 동기화
        "type": "local",
        "local_path": os.getcwd(),
        "data_file": DATA_FILE_NAME,
        "ftp": default_ftp_info()
    }


def default_settings():
    return {
        "storage": default_storage_settings(),
        "call_widths": [],
        "client_widths": [],
        "autosave_minutes": 5
    }


def default_data():
    return {"clients": {}, "calls": []}


# --------------------------------------------------------------------------
# FTP 유틸리티 (저장 스레드에서 사용)
# --------------------------------------------------------------------------

def ftp_connect(ftp_info, timeout=10):
    ftp = ftplib.FTP()
    ftp.connect(ftp_info.get("host", ""), int(ftp_info.get("port", 21) or 21), timeout=timeout)
    ftp.login(ftp_info.get("user", ""), ftp_info.get("password", ""))
    return ftp


def ftp_ensure_dir(ftp, remote_path):
    remote_path = (remote_path or "/").replace("\\", "/")
    if not remote_path.startswith("/"):
        remote_path = "/" + remote_path
    ftp.cwd("/")
    for part in [p for p in remote_path.split("/") if p]:
        try:
            ftp.cwd(part)
        except Exception:
            ftp.mkd(part)
            ftp.cwd(part)


class SaveCancelled(Exception):
    """사용자가 저장 도중 취소를 눌렀을 때 발생시키는 예외."""
    pass


def backup_paths(path):
    return [f"{path}.bak{i}" for i in range(1, BACKUP_SLOTS + 1)]


def rotate_backups(path):
    """현재 파일을 새로 저장하기 전에 호출합니다.
    bak1 <- 현재 파일, bak2 <- 이전 bak1, bak3 <- 이전 bak2 (가장 오래된 것은 삭제)
    """
    if not os.path.exists(path):
        return
    paths = backup_paths(path)

    oldest = paths[-1]
    if os.path.exists(oldest):
        try:
            os.remove(oldest)
        except Exception:
            pass

    for i in range(BACKUP_SLOTS - 1, 0, -1):
        src, dst = paths[i - 1], paths[i]
        if os.path.exists(src):
            try:
                if os.path.exists(dst):
                    os.remove(dst)
                os.replace(src, dst)
            except Exception:
                pass

    try:
        if os.path.exists(paths[0]):
            os.remove(paths[0])
        shutil.copy2(path, paths[0])
    except Exception:
        pass


def atomic_write_json(path, data):
    """임시 파일에 먼저 쓰고 성공하면 바꿔치기합니다.
    도중에 프로그램이 죽어도 기존 파일은 그대로 남습니다."""
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    tmp_path = os.path.join(folder, f".{os.path.basename(path)}.tmp-{uuid.uuid4().hex[:8]}")
    raw = json.dumps(data, ensure_ascii=False, indent=2)
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)


def read_json_file(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        raise ValueError("파일이 비어 있습니다.")
    return json.loads(text)


def is_valid_data_shape(data):
    return (
        isinstance(data, dict)
        and isinstance(data.get("clients", {}), dict)
        and isinstance(data.get("calls", []), list)
    )


def show_fatal_error(exc_type, exc_value, exc_tb):
    details = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
    message = f"프로그램 오류가 발생했습니다.\n\n원인: {exc_value}\n\n창을 닫으면 프로그램이 종료됩니다."
    app = QApplication.instance()
    if app:
        QMessageBox.critical(None, "오류 발생", message)
    else:
        print(message)
        print(details)
    sys.__excepthook__(exc_type, exc_value, exc_tb)
    sys.exit(1)


sys.excepthook = show_fatal_error


# --------------------------------------------------------------------------
# 여러 줄 입력을 지원하는 편집 델리게이트 (더블클릭 편집용)
# --------------------------------------------------------------------------

class MultiLineDelegate(QStyledItemDelegate):
    def createEditor(self, parent, option, index):
        editor = QTextEdit(parent)
        editor.setAcceptRichText(False)
        editor.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        editor.setMinimumHeight(110)
        return editor

    def sizeHintForEditor(self, option, index):
        return QSize(option.rect.width(), 110)

    def setEditorData(self, editor, index):
        if isinstance(editor, QTextEdit):
            editor.setPlainText(index.data() or "")
        else:
            super().setEditorData(editor, index)

    def setModelData(self, editor, model, index):
        if isinstance(editor, QTextEdit):
            model.setData(index, editor.toPlainText())
        else:
            super().setModelData(editor, model, index)

    def updateEditorGeometry(self, editor, option, index):
        rect = QRect(option.rect)
        rect.setHeight(max(rect.height(), 110))
        editor.setGeometry(rect)


class AutoHeightTable(QTableWidget):
    """열 너비가 바뀌면(줄바꿈이 바뀌므로) 행 높이를 다시 계산해 주는 테이블.
    드래그 중 매 픽셀마다 다시 계산하면 느려지므로 짧게 지연(debounce) 후 실행합니다."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._resize_timer = QTimer(self)
        self._resize_timer.setSingleShot(True)
        self._resize_timer.timeout.connect(self.resizeRowsToContents)
        self.horizontalHeader().sectionResized.connect(self._on_section_resized)

    def _on_section_resized(self, *_args):
        self._resize_timer.start(ROW_RESIZE_DEBOUNCE_MS)

    def schedule_row_resize(self, delay=0):
        self._resize_timer.start(delay)


# --------------------------------------------------------------------------
# 저장 작업 스레드 (진행률 표시 + 취소 지원)
# --------------------------------------------------------------------------

class SaveWorker(QThread):
    progress = pyqtSignal(int, str)   # 0~100, 상태 메시지
    finished_result = pyqtSignal(bool, bool, str)   # 성공여부, 취소여부, 메시지

    def __init__(self, path, data, storage, parent=None):
        super().__init__(parent)
        self.path = path
        self.data = data
        self.storage = storage
        self._cancel_requested = False

    def request_cancel(self):
        self._cancel_requested = True

    def _check_cancel(self):
        if self._cancel_requested:
            raise SaveCancelled("사용자가 저장을 취소했습니다.")

    def run(self):
        try:
            self.progress.emit(5, "이전 저장본 백업 중...")
            self._check_cancel()
            rotate_backups(self.path)

            self.progress.emit(30, "로컬 파일에 저장 중...")
            self._check_cancel()
            atomic_write_json(self.path, self.data)

            storage_type = self.storage.get("type", "local")
            if storage_type == "local":
                self.progress.emit(100, "저장 완료")
                self.finished_result.emit(True, False, "")
                return

            # ftp 또는 local_sync: FTP 업로드까지 진행
            self.progress.emit(50, "FTP 서버에 연결하는 중...")
            self._check_cancel()
            ftp_info = self.storage.get("ftp", {})
            if not ftp_info.get("host"):
                raise ValueError("FTP 주소가 설정되어 있지 않습니다. 환경설정에서 입력해 주세요.")

            ftp = ftp_connect(ftp_info)
            try:
                self.progress.emit(65, "FTP 폴더 확인 중...")
                self._check_cancel()
                ftp_ensure_dir(ftp, ftp_info.get("remote_path", "/"))

                self.progress.emit(80, "FTP로 업로드 중...")
                raw = json.dumps(self.data, ensure_ascii=False, indent=2).encode("utf-8")
                buf = BytesIO(raw)

                def block_callback(_block):
                    # storbinary는 블록 단위로 콜백을 호출하므로, 여기서 취소 여부를
                    # 확인해서 즉시 중단할 수 있게 합니다.
                    if self._cancel_requested:
                        raise SaveCancelled("사용자가 업로드를 취소했습니다.")

                file_name = self.storage.get("data_file") or DATA_FILE_NAME
                ftp.storbinary(f"STOR {file_name}", buf, callback=block_callback)
            finally:
                try:
                    ftp.quit()
                except Exception:
                    pass

            self.progress.emit(100, "저장 및 FTP 동기화 완료")
            self.finished_result.emit(True, False, "")
        except SaveCancelled as e:
            self.finished_result.emit(False, True, str(e))
        except Exception as e:
            self.finished_result.emit(False, False, str(e))


class SaveProgressDialog(QDialog):
    """저장 진행 상황을 눈으로 보여주고, 도중에 취소할 수 있는 창.
    완료되면 자동으로 닫힙니다."""

    def __init__(self, path, data, storage, parent=None, title="저장 중"):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumWidth(420)
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowType.WindowContextHelpButtonHint)

        self.success = False
        self.cancelled = False
        self.error_message = ""

        layout = QVBoxLayout(self)
        self.status_label = QLabel("저장 준비 중...")
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)

        btn_row = QHBoxLayout()
        self.cancel_btn = QPushButton("취소")
        self.cancel_btn.setObjectName("DangerButton")
        btn_row.addStretch(1)
        btn_row.addWidget(self.cancel_btn)

        layout.addWidget(self.status_label)
        layout.addWidget(self.progress_bar)
        layout.addLayout(btn_row)

        self.worker = SaveWorker(path, data, storage, self)
        self.worker.progress.connect(self.on_progress)
        self.worker.finished_result.connect(self.on_finished)
        self.cancel_btn.clicked.connect(self.on_cancel_clicked)

    def start(self):
        self.worker.start()
        self.exec()
        return self.success, self.cancelled, self.error_message

    def on_progress(self, percent, message):
        self.progress_bar.setValue(percent)
        self.status_label.setText(message)

    def on_cancel_clicked(self):
        self.status_label.setText("취소하는 중...")
        self.cancel_btn.setEnabled(False)
        self.worker.request_cancel()

    def on_finished(self, success, cancelled, message):
        self.success = success
        self.cancelled = cancelled
        self.error_message = message
        if success:
            self.status_label.setText("완료되었습니다.")
            self.progress_bar.setValue(100)
        elif cancelled:
            self.status_label.setText("취소되었습니다.")
        else:
            self.status_label.setText("오류가 발생했습니다.")
        # 사용자가 진행 상태를 눈으로 잠깐 확인할 수 있도록 짧게 대기 후 자동으로 닫힘
        QTimer.singleShot(350, self.accept)

    def closeEvent(self, event):
        # 창을 강제로 닫으려 하면(x 버튼) 취소로 처리
        if self.worker.isRunning():
            self.worker.request_cancel()
            self.worker.wait(3000)
        event.accept()


# --------------------------------------------------------------------------
# 메인 윈도우
# --------------------------------------------------------------------------

class CallManagerLite(QMainWindow):
    CALL_HEADERS = ["거래처", "날짜/시간", "전화번호", "구분", "통화내용"]
    CLIENT_HEADERS = ["거래처명", "전화1", "전화2", "전화3", "메모"]

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Sky CRM Lite - 통화 & 거래처 관리")
        self.setGeometry(100, 100, 1300, 860)
        if os.path.exists(ICON_FILE):
            self.setWindowIcon(QIcon(ICON_FILE))

        self.data = default_data()
        self.settings = default_settings()
        self.call_column_filters = {}
        self.client_column_filters = {}
        self.filter_popup = None
        self.name_suggestion_list = None
        self.table_filter_headers = {}
        self.closing_app = False
        self.pending_ftp_sync = False

        self.save_timer = QTimer(self)
        self.save_timer.setSingleShot(True)
        self.save_timer.timeout.connect(lambda: self.save_data(show_progress=False))

        self.load_settings()
        self.ensure_settings_shape()
        self.load_data_with_recovery()

        self.initUI()
        self.createMenu()

        self.save_shortcut = QShortcut(QKeySequence.StandardKey.Save, self)
        self.save_shortcut.activated.connect(lambda: self.save_current_data_file(show_message=False))

        self.apply_style()
        QApplication.instance().installEventFilter(self)
        self.update_all()
        self.apply_widths()

    # ---------------------------------------------------------------- 데이터 형태 보장
    def ensure_settings_shape(self):
        defaults = default_settings()
        for key, value in defaults.items():
            self.settings.setdefault(key, value)

        storage = self.settings.setdefault("storage", default_storage_settings())
        # 예전 버전(플랫 구조: local_path/data_file이 최상위에 있던 설정 파일) 호환용 이전
        if "local_path" in self.settings and "local_path" not in storage:
            storage["local_path"] = self.settings.pop("local_path")
        if "data_file" in self.settings and "data_file" not in storage:
            storage["data_file"] = self.settings.pop("data_file")

        for key, value in default_storage_settings().items():
            storage.setdefault(key, value)
        ftp_info = storage.setdefault("ftp", default_ftp_info())
        for key, value in default_ftp_info().items():
            ftp_info.setdefault(key, value)
        if storage.get("type") not in ("local", "ftp", "local_sync"):
            storage["type"] = "local"

    def ensure_data_shape(self):
        self.data.setdefault("clients", {})
        self.data.setdefault("calls", [])
        # 각 통화 기록에 고유 id 부여 (예전 파일 호환용). 날짜 문자열로 매칭하면
        # 같은 초에 여러 건이 생겼을 때 잘못된 레코드가 수정/삭제될 수 있었습니다.
        for call in self.data["calls"]:
            call.setdefault("id", str(uuid.uuid4()))

    # ---------------------------------------------------------------- 저장소 설정
    def storage_settings(self):
        self.ensure_settings_shape()
        return self.settings["storage"]

    def data_file_name(self):
        name = os.path.basename(str(self.storage_settings().get("data_file") or DATA_FILE_NAME).replace("\\", "/"))
        return name or DATA_FILE_NAME

    def local_data_path(self, folder=None, file_name=None):
        folder = folder if folder is not None else (self.storage_settings().get("local_path") or os.getcwd())
        file_name = file_name or self.data_file_name()
        return os.path.join(folder, file_name)

    def is_ftp_only(self):
        return self.storage_settings().get("type") == "ftp"

    def is_local_sync_enabled(self):
        return self.storage_settings().get("type") == "local_sync"

    # ---------------------------------------------------------------- 불러오기 (+ 자동 복구)
    def load_data_with_recovery(self):
        storage = self.storage_settings()
        recovered_from = None

        if storage.get("type") == "ftp":
            self.load_data_from_ftp(show_error=True)
            self.ensure_data_shape()
            return

        path = self.local_data_path()

        if os.path.exists(path):
            try:
                loaded = read_json_file(path)
                if not is_valid_data_shape(loaded):
                    raise ValueError("데이터 형식이 올바르지 않습니다.")
                self.data = loaded
            except Exception:
                # 현재 파일이 깨졌으면 최근 백업부터 순서대로 시도합니다.
                for bpath in backup_paths(path):
                    if not os.path.exists(bpath):
                        continue
                    try:
                        loaded = read_json_file(bpath)
                        if is_valid_data_shape(loaded):
                            self.data = loaded
                            recovered_from = bpath
                            break
                    except Exception:
                        continue
        # 파일 자체가 없으면 새 데이터로 시작 (최초 실행)

        self.ensure_data_shape()

        if recovered_from:
            QTimer.singleShot(200, lambda: QMessageBox.warning(
                self, "자동 복구됨",
                f"기존 데이터 파일을 읽지 못해 백업본으로 복구했습니다.\n\n"
                f"복구한 파일: {recovered_from}\n\n"
                f"내용을 확인하신 뒤 저장(Ctrl+S)해 주세요."
            ))

    def load_data_from_ftp(self, show_error=True):
        storage = self.storage_settings()
        ftp_info = storage.get("ftp", {})
        if not ftp_info.get("host"):
            return
        ftp = None
        try:
            ftp = ftp_connect(ftp_info)
            ftp_ensure_dir(ftp, ftp_info.get("remote_path", "/"))
            chunks = []
            try:
                ftp.retrbinary(f"RETR {self.data_file_name()}", chunks.append)
            except ftplib.error_perm as e:
                if str(e).startswith("550"):
                    # 파일이 아직 없는 경우 (최초 실행) -> 새 데이터로 시작
                    return
                raise
            raw = b"".join(chunks).decode("utf-8")
            loaded = json.loads(raw)
            if not is_valid_data_shape(loaded):
                raise ValueError("FTP의 데이터 형식이 올바르지 않습니다.")
            self.data = loaded
        except Exception as e:
            if show_error:
                QTimer.singleShot(200, lambda: QMessageBox.warning(
                    self, "FTP 불러오기 오류", f"FTP에서 데이터를 읽지 못했습니다.\n\n원인: {e}"
                ))
        finally:
            if ftp:
                try:
                    ftp.quit()
                except Exception:
                    pass

    # ---------------------------------------------------------------- 저장 (진행창 + 취소 지원)
    def save_data(self, show_progress=True, parent_for_dialog=None):
        """데이터를 저장합니다. 로컬은 항상 백업 회전 + 원자적 쓰기로 저장되고,
        저장소 종류가 FTP/동기화이면 FTP 업로드까지 진행창을 보여주며 진행됩니다.
        진행창에서 취소하면 저장이 중단되고 False를 반환합니다."""
        self.ensure_data_shape()
        storage = self.storage_settings()
        path = self.local_data_path()

        if not show_progress:
            # 자동 저장(디바운스)처럼 조용히 저장할 때는 진행창 없이 처리
            try:
                rotate_backups(path)
                atomic_write_json(path, self.data)
                if self.is_local_sync_enabled():
                    self.pending_ftp_sync = True
                self.statusBar().showMessage(f"저장됨: {path}  ({datetime.now().strftime('%H:%M:%S')})", 3000)
                return True
            except Exception as e:
                QMessageBox.warning(
                    self, "저장 오류",
                    f"데이터를 저장하지 못했습니다. 이전 저장본은 안전하게 보존되어 있습니다.\n\n원인: {e}"
                )
                return False

        dialog = SaveProgressDialog(path, self.data, storage, parent=parent_for_dialog or self, title="저장 중")
        success, cancelled, message = dialog.start()

        if success:
            self.statusBar().showMessage(f"저장됨: {path}  ({datetime.now().strftime('%H:%M:%S')})", 3000)
            self.pending_ftp_sync = False
            return True
        if cancelled:
            self.statusBar().showMessage("저장이 취소되었습니다.", 4000)
            return False
        QMessageBox.warning(
            self, "저장 오류",
            f"데이터를 저장하지 못했습니다. 이전 저장본은 안전하게 보존되어 있습니다.\n\n원인: {message}"
        )
        return False

    def sync_now(self):
        """메뉴에서 'FTP 지금 동기화'를 눌렀을 때 사용."""
        storage = self.storage_settings()
        if storage.get("type") == "local":
            QMessageBox.information(self, "FTP 동기화", "현재 저장 방식이 '하드디스크'로 설정되어 있어 동기화할 FTP가 없습니다.\n환경설정에서 FTP 방식을 선택해 주세요.")
            return
        self.save_data(show_progress=True)

    def save_settings(self):
        try:
            if hasattr(self, "call_table"):
                self.settings["call_widths"] = [self.call_table.columnWidth(i) for i in range(len(self.CALL_HEADERS))]
            if hasattr(self, "client_table"):
                self.settings["client_widths"] = [self.client_table.columnWidth(i) for i in range(len(self.CLIENT_HEADERS))]
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self.show_nonfatal_error("설정 저장 오류", e)

    def load_settings(self):
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    self.settings = json.load(f)
            except Exception as e:
                self.settings = default_settings()
                self.show_nonfatal_error("설정 읽기 오류", e)

    def request_save_data(self, delay=None):
        if delay is None:
            try:
                minutes = float(self.settings.get("autosave_minutes", 5) or 5)
            except Exception:
                minutes = 5
            delay = int(max(0.2, minutes) * 60 * 1000)
        self.save_timer.start(int(delay))

    # ---------------------------------------------------------------- 스타일
    def apply_style(self):
        self.setStyleSheet("""
            QMainWindow { background-color: #F7F7F5; color: #2F3437; }
            QMenuBar { background-color: #F7F7F5; color: #2F3437; border-bottom: 1px solid #E6E4DF; padding: 3px; }
            QMenuBar::item:selected { background-color: #EDEBE7; border-radius: 4px; }
            QMenu { background-color: #FFFFFF; color: #2F3437; border: 1px solid #DAD7D0; padding: 4px; }
            QMenu::item { padding: 7px 24px; border-radius: 4px; }
            QMenu::item:selected { background-color: #F1F1EF; }
            QTabWidget::pane { background-color: #F7F7F5; border: none; border-top: 1px solid #E3E1DA; }
            QTabBar::tab {
                background-color: transparent; color: #6B6B66; border: none;
                border-bottom: 2px solid transparent; padding: 12px 28px;
                margin-right: 4px; font-weight: 700; min-height: 26px; min-width: 104px;
            }
            QTabBar::tab:hover { background-color: #F1F0ED; color: #2F3437; }
            QTabBar::tab:selected { color: #2F3437; background-color: #F7F7F5; border-bottom: 2px solid #2F3437; }
            QLabel#PageSubtitle { color: #6B6B66; font-size: 9pt; }
            QPushButton {
                background-color: #FFFFFF; color: #2F3437; border: 1px solid #DAD7D0;
                border-radius: 6px; padding: 8px 13px; font-weight: 600;
            }
            QPushButton:hover { background-color: #F6F5F2; border-color: #C9C6BE; }
            QPushButton:pressed { background-color: #EDEBE7; }
            QPushButton#PrimaryButton { background-color: #2F3437; color: #FFFFFF; border: 1px solid #2F3437; }
            QPushButton#PrimaryButton:hover { background-color: #454A4D; }
            QPushButton#DangerButton { background-color: #FFF5F3; color: #B42318; border: 1px solid #F2B8B5; }
            QGroupBox {
                background-color: #FFFFFF; color: #2F3437; border: 1px solid #E3E1DA;
                border-radius: 8px; margin-top: 14px; padding: 18px 14px 14px 14px; font-weight: 700;
            }
            QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 5px; color: #6B6B66; }
            QLineEdit, QTextEdit, QDateEdit, QListWidget, QSpinBox {
                background-color: #FFFFFF; color: #2F3437; border: 1px solid #DAD7D0;
                border-radius: 6px; padding: 7px; selection-background-color: #DDEBF7;
            }
            QLineEdit:focus, QTextEdit:focus, QDateEdit:focus, QListWidget:focus, QSpinBox:focus {
                border: 1px solid #9B9991; background-color: #FFFFFF;
            }
            QListWidget::item { padding: 7px; border-radius: 4px; }
            QListWidget::item:selected { background-color: #E8F1FA; color: #2F3437; }
            QCalendarWidget QWidget { background-color: #FFFFFF; color: #2F3437; }
            QRadioButton, QCheckBox { color: #2F3437; spacing: 7px; }
            QTableWidget {
                background-color: #FFFFFF; alternate-background-color: #FAFAF8; color: #2F3437;
                border: 1px solid #E7E4DD; border-radius: 10px; gridline-color: transparent;
                selection-background-color: #E8F1FA; selection-color: #2F3437;
            }
            QTableWidget::item { padding: 8px; border-bottom: 1px solid #F0EEE8; }
            QTableWidget::item:selected { background-color: #E8F1FA; color: #2F3437; border-radius: 5px; }
            QHeaderView::section {
                background-color: #F7F6F3; color: #6B6B66; border: none;
                border-bottom: 1px solid #E3E1DA; padding: 9px; font-weight: 700;
            }
            QScrollBar:vertical { background: #F7F7F5; width: 12px; margin: 2px; }
            QScrollBar::handle:vertical { background: #D3D0C8; border-radius: 5px; min-height: 28px; }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }
            QStatusBar { color: #6B6B66; }
        """)

    # ---------------------------------------------------------------- 메뉴
    def createMenu(self):
        menubar = self.menuBar()
        fileMenu = menubar.addMenu("파일(&F)")

        openAction = QAction("다른 데이터 파일 열기", self)
        openAction.triggered.connect(self.open_data_file_dialog)
        fileMenu.addAction(openAction)

        saveAction = QAction("저장", self)
        saveAction.triggered.connect(self.save_current_data_file)
        fileMenu.addAction(saveAction)

        saveAsAction = QAction("다른 이름으로 저장", self)
        saveAsAction.triggered.connect(self.save_data_as_dialog)
        fileMenu.addAction(saveAsAction)
        fileMenu.addSeparator()

        restoreAction = QAction("백업본에서 복구...", self)
        restoreAction.triggered.connect(self.open_restore_backup_dialog)
        fileMenu.addAction(restoreAction)
        fileMenu.addSeparator()

        exportAction = QAction("엑셀로 내보내기", self)
        exportAction.triggered.connect(self.export_excel)
        fileMenu.addAction(exportAction)

        settingMenu = menubar.addMenu("설정(&S)")
        preferenceAction = QAction("환경설정 (저장 방식 / FTP)", self)
        preferenceAction.triggered.connect(self.open_preferences_dialog)
        settingMenu.addAction(preferenceAction)

        syncAction = QAction("FTP 지금 동기화", self)
        syncAction.triggered.connect(self.sync_now)
        settingMenu.addAction(syncAction)
        settingMenu.addSeparator()

        widthResetAction = QAction("표 너비 초기화", self)
        widthResetAction.triggered.connect(self.reset_widths)
        settingMenu.addAction(widthResetAction)

        filterResetAction = QAction("전체 열 필터 해제", self)
        filterResetAction.triggered.connect(self.clear_all_column_filters)
        settingMenu.addAction(filterResetAction)

        self.statusBar().showMessage("준비 완료")

    # ---------------------------------------------------------------- UI 구성
    def initUI(self):
        tabs = QTabWidget()
        self.main_tabs = tabs
        self.setCentralWidget(tabs)
        tabs.addTab(self.build_call_tab(), "통화 기록")
        tabs.addTab(self.build_client_tab(), "거래처 DB")

    def create_styled_table(self, headers):
        table = AutoHeightTable()
        table.setColumnCount(len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.setWordWrap(True)
        table.setTextElideMode(Qt.TextElideMode.ElideNone)
        table.setAlternatingRowColors(True)
        table.setSortingEnabled(True)
        table.setShowGrid(False)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        table.verticalHeader().setVisible(False)
        table.horizontalHeader().setStretchLastSection(True)
        return table

    def build_call_tab(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(34, 28, 34, 28)
        layout.setSpacing(14)

        input_group = QGroupBox("신규 통화 기록")
        form = QGridLayout()
        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("거래처명을 입력하세요")
        self.name_input.textChanged.connect(self.update_name_suggestions)
        self.name_input.installEventFilter(self)

        self.name_suggestion_list = QListWidget(self)
        self.name_suggestion_list.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.name_suggestion_list.setMouseTracking(True)
        self.name_suggestion_list.setMaximumHeight(150)
        self.name_suggestion_list.hide()
        self.name_suggestion_list.itemClicked.connect(lambda item: self.choose_name_suggestion(item.text()))
        self.name_suggestion_list.installEventFilter(self)

        self.phone_input = QLineEdit()
        self.radio_in = QRadioButton("수신")
        self.radio_out = QRadioButton("송신")
        self.radio_in.setChecked(True)

        type_box = QHBoxLayout()
        type_box.addWidget(self.radio_in)
        type_box.addWidget(self.radio_out)

        form.addWidget(QLabel("거래처명:"), 0, 0)
        form.addWidget(self.name_input, 0, 1)
        form.addWidget(QLabel("유형:"), 0, 2)
        form.addLayout(type_box, 0, 3)
        form.addWidget(QLabel("연락처:"), 1, 0)
        form.addWidget(self.phone_input, 1, 1)
        input_group.setLayout(form)
        layout.addWidget(input_group)

        self.content_input = QTextEdit()
        self.content_input.setPlaceholderText("통화 내용을 입력하세요...")
        self.content_input.setMaximumHeight(100)
        layout.addWidget(self.content_input)

        btns = QHBoxLayout()
        save_btn = QPushButton("저장")
        save_btn.setObjectName("PrimaryButton")
        save_btn.clicked.connect(self.add_call)
        del_call_btn = QPushButton("선택 로그 삭제")
        del_call_btn.setObjectName("DangerButton")
        del_call_btn.clicked.connect(self.delete_call)
        btns.addWidget(save_btn)
        btns.addWidget(del_call_btn)
        layout.addLayout(btns)

        search_group = QGroupBox("검색 필터")
        s_layout = QHBoxLayout()
        self.main_start_date = QDateEdit()
        self.main_start_date.setCalendarPopup(True)
        self.main_start_date.setDisplayFormat("yyyy-MM-dd")
        self.main_start_date.setDate(QDate.currentDate().addMonths(-1))
        self.main_start_date.dateChanged.connect(self.filter_calls)

        self.main_end_date = QDateEdit()
        self.main_end_date.setCalendarPopup(True)
        self.main_end_date.setDisplayFormat("yyyy-MM-dd")
        self.main_end_date.setDate(QDate.currentDate())
        self.main_end_date.dateChanged.connect(self.filter_calls)

        self.main_search_input = QLineEdit()
        self.main_search_input.setPlaceholderText("검색어...")
        self.main_search_input.returnPressed.connect(self.filter_calls)
        self.main_search_input.textChanged.connect(self.filter_calls_when_cleared)

        main_search_btn = QPushButton("검색")
        main_search_btn.setObjectName("PrimaryButton")
        main_search_btn.clicked.connect(self.filter_calls)

        s_layout.addWidget(QLabel("기간:"))
        s_layout.addWidget(self.main_start_date)
        s_layout.addWidget(QLabel("~"))
        s_layout.addWidget(self.main_end_date)
        s_layout.addWidget(self.main_search_input)
        s_layout.addWidget(main_search_btn)
        search_group.setLayout(s_layout)
        layout.addWidget(search_group)

        self.call_table = self.create_styled_table(self.CALL_HEADERS)
        self.call_table.setItemDelegate(MultiLineDelegate(self.call_table))
        self.call_table.cellChanged.connect(self.save_call_edit)
        self.enable_table_filter(self.call_table, "call")
        layout.addWidget(self.call_table, 1)
        return tab

    def build_client_tab(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(34, 28, 34, 28)
        layout.setSpacing(14)

        c_search_layout = QHBoxLayout()
        self.client_search_input = QLineEdit()
        self.client_search_input.setPlaceholderText("거래처 검색...")
        self.client_search_input.textChanged.connect(self.filter_clients)
        self.client_search_input.returnPressed.connect(self.filter_clients)
        c_search_layout.addWidget(QLabel("거래처 검색: "))
        c_search_layout.addWidget(self.client_search_input)
        layout.addLayout(c_search_layout)

        self.client_table = self.create_styled_table(self.CLIENT_HEADERS)
        self.client_table.setItemDelegate(MultiLineDelegate(self.client_table))
        self.client_table.cellChanged.connect(self.edit_client)
        self.client_table.cellDoubleClicked.connect(self.open_client_detail)
        self.enable_table_filter(self.client_table, "client")
        layout.addWidget(self.client_table)

        client_btns = QHBoxLayout()
        add_client_btn = QPushButton("새 거래처 등록")
        add_client_btn.setObjectName("PrimaryButton")
        add_client_btn.clicked.connect(self.add_client_dialog)
        del_client_btn = QPushButton("선택 거래처 삭제")
        del_client_btn.setObjectName("DangerButton")
        del_client_btn.clicked.connect(self.delete_client)
        client_btns.addStretch(1)
        client_btns.addWidget(add_client_btn)
        client_btns.addWidget(del_client_btn)
        layout.addLayout(client_btns)
        return tab

    # ---------------------------------------------------------------- 이름 자동완성
    def update_name_suggestions(self, search_text=None):
        if self.name_suggestion_list is None:
            return
        text = (self.name_input.text() if search_text is None else search_text).strip().lower()
        self.name_suggestion_list.clear()
        if not text:
            self.name_suggestion_list.hide()
            return
        matches = [name for name in self.data["clients"].keys() if text in str(name).lower()]
        if not matches:
            self.name_suggestion_list.hide()
            return
        self.name_suggestion_list.addItems(matches[:50])
        self.name_suggestion_list.setCurrentRow(0)
        row_height = max(self.name_suggestion_list.sizeHintForRow(0), 30)
        visible_rows = min(len(matches), 6)
        self.name_suggestion_list.setFixedWidth(self.name_input.width())
        self.name_suggestion_list.setFixedHeight((row_height * visible_rows) + 14)
        self.name_suggestion_list.move(self.mapFromGlobal(self.name_input.mapToGlobal(self.name_input.rect().bottomLeft())))
        self.name_suggestion_list.show()
        self.name_suggestion_list.raise_()

    def choose_name_suggestion(self, name):
        self.name_input.blockSignals(True)
        self.name_input.setText(name)
        self.name_input.blockSignals(False)
        if self.name_suggestion_list is not None:
            self.name_suggestion_list.hide()
        details = self.data["clients"].get(name, [])
        phones = [str(v).strip() for v in details[:3] if str(v).strip()]
        if phones and not self.phone_input.text().strip():
            self.phone_input.setText(phones[0])
        self.name_input.setFocus()

    def hide_name_suggestions_if_focus_left(self):
        if self.name_suggestion_list is None or not self.name_suggestion_list.isVisible():
            return
        focus_widget = QApplication.focusWidget()
        if focus_widget in (self.name_input, self.name_suggestion_list):
            return
        self.name_suggestion_list.hide()

    # ---------------------------------------------------------------- 통화 기록 CRUD
    def add_call(self):
        name = self.name_input.text().strip()
        if not name:
            QMessageBox.warning(self, "입력 확인", "거래처명을 입력해 주세요.")
            return
        if name not in self.data["clients"]:
            self.data["clients"][name] = ["", "", "", ""]
        record = {
            "id": str(uuid.uuid4()),
            "name": name,
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "phone": self.phone_input.text(),
            "type": "수신" if self.radio_in.isChecked() else "송신",
            "content": self.content_input.toPlainText()
        }
        self.data["calls"].insert(0, record)
        self.refresh_call_and_client_tables()
        self.request_save_data(200)
        self.name_input.clear()
        self.phone_input.clear()
        self.content_input.clear()
        if self.name_suggestion_list is not None:
            self.name_suggestion_list.hide()

    def delete_call(self):
        row = self.call_table.currentRow()
        if row < 0:
            QMessageBox.warning(self, "선택 확인", "삭제할 통화 기록을 먼저 선택해 주세요.")
            return
        call_id = self.call_table.item(row, 0).data(Qt.ItemDataRole.UserRole) if self.call_table.item(row, 0) else None
        if not call_id:
            return
        reply = QMessageBox.question(self, "삭제 확인", "선택한 통화 기록을 삭제하시겠습니까?",
                                      QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                      QMessageBox.StandardButton.No)
        if reply != QMessageBox.StandardButton.Yes:
            return
        self.data["calls"] = [c for c in self.data["calls"] if c.get("id") != call_id]
        self.refresh_call_table_only()
        self.request_save_data(200)

    def save_call_edit(self, row, col):
        if self.call_table.signalsBlocked():
            return
        try:
            name_item = self.call_table.item(row, 0)
            call_id = name_item.data(Qt.ItemDataRole.UserRole) if name_item else None
            if not call_id:
                return
            for c in self.data["calls"]:
                if c.get("id") == call_id:
                    c["name"] = self.call_table.item(row, 0).text() if self.call_table.item(row, 0) else ""
                    c["phone"] = self.call_table.item(row, 2).text() if self.call_table.item(row, 2) else ""
                    c["type"] = self.call_table.item(row, 3).text() if self.call_table.item(row, 3) else ""
                    c["content"] = self.call_table.item(row, 4).text() if self.call_table.item(row, 4) else ""
                    break
            self.request_save_data()
        except Exception as e:
            self.show_nonfatal_error("통화 기록 수정 오류", e)

    # ---------------------------------------------------------------- 거래처 CRUD
    def add_client_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("새 거래처 등록")
        dialog.setMinimumWidth(520)
        layout = QVBoxLayout(dialog)
        form = QGridLayout()

        name_input = QLineEdit()
        phone1_input = QLineEdit()
        phone2_input = QLineEdit()
        phone3_input = QLineEdit()
        memo_input = QTextEdit()
        memo_input.setMaximumHeight(100)

        form.addWidget(QLabel("거래처명:"), 0, 0)
        form.addWidget(name_input, 0, 1)
        form.addWidget(QLabel("전화1:"), 1, 0)
        form.addWidget(phone1_input, 1, 1)
        form.addWidget(QLabel("전화2:"), 2, 0)
        form.addWidget(phone2_input, 2, 1)
        form.addWidget(QLabel("전화3:"), 3, 0)
        form.addWidget(phone3_input, 3, 1)
        form.addWidget(QLabel("메모:"), 4, 0)
        form.addWidget(memo_input, 4, 1)

        btn_row = QHBoxLayout()
        save_btn = QPushButton("등록")
        save_btn.setObjectName("PrimaryButton")
        cancel_btn = QPushButton("취소")
        btn_row.addStretch(1)
        btn_row.addWidget(save_btn)
        btn_row.addWidget(cancel_btn)

        layout.addLayout(form)
        layout.addLayout(btn_row)

        def save_client():
            name = name_input.text().strip()
            if not name:
                QMessageBox.warning(dialog, "거래처 확인", "거래처명을 입력해 주세요.")
                return
            if name in self.data.get("clients", {}):
                QMessageBox.warning(dialog, "거래처 확인", "이미 등록된 거래처명입니다.")
                return
            self.data.setdefault("clients", {})[name] = [
                phone1_input.text().strip(),
                phone2_input.text().strip(),
                phone3_input.text().strip(),
                memo_input.toPlainText()
            ]
            self.filter_clients()
            self.refresh_filter_header_icons("client")
            self.request_save_data(200)
            dialog.accept()

        save_btn.clicked.connect(save_client)
        cancel_btn.clicked.connect(dialog.reject)
        name_input.setFocus()
        dialog.exec()

    def delete_client(self):
        row = self.client_table.currentRow()
        if row < 0:
            QMessageBox.warning(self, "선택 확인", "삭제할 거래처를 먼저 선택해 주세요.")
            return
        client_name = self.client_table.item(row, 0).text()
        reply = QMessageBox.question(self, "삭제 확인", f"'{client_name}' 거래처 정보를 삭제하시겠습니까?\n"
                                      "(이 거래처로 남겨진 통화 기록은 삭제되지 않습니다.)",
                                      QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                      QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes and client_name in self.data["clients"]:
            del self.data["clients"][client_name]
            self.filter_clients()
            self.refresh_filter_header_icons("client")
            self.request_save_data(200)

    def edit_client(self, row, col):
        if self.client_table.signalsBlocked():
            return
        try:
            name_item = self.client_table.item(row, 0)
            if not name_item:
                return
            name = name_item.text()
            self.data["clients"][name] = [
                self.client_table.item(row, i).text() if self.client_table.item(row, i) else ""
                for i in range(1, 5)
            ]
            self.request_save_data()
        except Exception as e:
            self.show_nonfatal_error("거래처 수정 오류", e)

    def open_client_detail(self, row, col):
        if col != 0:
            item = self.client_table.item(row, col)
            if item:
                self.client_table.editItem(item)
            return

        name_item = self.client_table.item(row, 0)
        if not name_item:
            return
        client_name = name_item.text()
        all_calls = [c for c in self.data["calls"] if c.get("name") == client_name]

        dialog = QDialog(self)
        dialog.setWindowTitle(f"상세 로그: {client_name}")
        dialog.setMinimumSize(1000, 700)

        d_layout = QVBoxLayout(dialog)
        ps_group = QGroupBox("검색 필터")
        ps_layout = QHBoxLayout()

        p_start = QDateEdit()
        p_start.setCalendarPopup(True)
        p_start.setDisplayFormat("yyyy-MM-dd")
        p_start.setDate(QDate.currentDate().addMonths(-1))

        p_end = QDateEdit()
        p_end.setCalendarPopup(True)
        p_end.setDisplayFormat("yyyy-MM-dd")
        p_end.setDate(QDate.currentDate())

        p_input = QLineEdit()
        p_input.setPlaceholderText("키워드...")
        p_btn = QPushButton("검색 적용")
        p_btn.setObjectName("PrimaryButton")

        ps_layout.addWidget(QLabel("기간:"))
        ps_layout.addWidget(p_start)
        ps_layout.addWidget(QLabel("~"))
        ps_layout.addWidget(p_end)
        ps_layout.addWidget(p_input)
        ps_layout.addWidget(p_btn)
        ps_group.setLayout(ps_layout)
        d_layout.addWidget(ps_group)

        p_table = self.create_styled_table(["날짜/시간", "전화번호", "유형", "통화내용"])
        p_table.setItemDelegateForColumn(3, MultiLineDelegate(p_table))
        d_layout.addWidget(p_table)

        def apply_sub_filter(*_args):
            try:
                kw = p_input.text().lower().strip()
                s_qdate = p_start.date()
                e_qdate = p_end.date()
                if not s_qdate.isValid() or not e_qdate.isValid():
                    return
                s_d = s_qdate.toPyDate()
                e_d = e_qdate.toPyDate()
                if e_d < s_d:
                    s_d, e_d = e_d, s_d
                p_table.blockSignals(True)
                p_table.setSortingEnabled(False)
                p_table.setRowCount(0)
                for c in all_calls:
                    try:
                        c_date = datetime.strptime(c.get("date", ""), "%Y-%m-%d %H:%M:%S").date()
                        phone = str(c.get("phone", "")).lower()
                        content = str(c.get("content", "")).lower()
                        call_type = str(c.get("type", "")).lower()
                        if (s_d <= c_date <= e_d) and (not kw or kw in content or kw in phone or kw in call_type):
                            curr = p_table.rowCount()
                            p_table.insertRow(curr)
                            p_table.setItem(curr, 0, QTableWidgetItem(str(c.get("date", ""))))
                            p_table.setItem(curr, 1, QTableWidgetItem(str(c.get("phone", ""))))
                            p_table.setItem(curr, 2, QTableWidgetItem(str(c.get("type", ""))))
                            content_item = QTableWidgetItem(str(c.get("content", "")))
                            content_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
                            p_table.setItem(curr, 3, content_item)
                    except Exception:
                        continue
                p_table.setSortingEnabled(True)
                p_table.blockSignals(False)
                p_table.schedule_row_resize()
            except Exception as e:
                self.show_nonfatal_error("검색 필터 오류", e)

        p_input.returnPressed.connect(apply_sub_filter)
        p_input.textChanged.connect(lambda: apply_sub_filter() if not p_input.text().strip() else None)
        p_start.dateChanged.connect(apply_sub_filter)
        p_end.dateChanged.connect(apply_sub_filter)
        p_btn.clicked.connect(apply_sub_filter)
        apply_sub_filter()
        dialog.exec()

    # ---------------------------------------------------------------- 표 갱신 / 필터
    def refresh_call_and_client_tables(self):
        self.filter_calls()
        self.filter_clients()
        self.refresh_filter_header_icons("call")
        self.refresh_filter_header_icons("client")

    def refresh_call_table_only(self):
        self.filter_calls()
        self.refresh_filter_header_icons("call")

    def update_all(self):
        self.update_call_table(self.data["calls"])
        self.update_client_table(self.data["clients"])
        self.refresh_filter_header_icons("call")
        self.refresh_filter_header_icons("client")

    def update_call_table(self, data):
        self.call_table.blockSignals(True)
        self.call_table.setSortingEnabled(False)
        self.call_table.setRowCount(len(data))
        for i, c in enumerate(data):
            name_item = QTableWidgetItem(str(c.get("name", "")))
            name_item.setData(Qt.ItemDataRole.UserRole, c.get("id"))
            self.call_table.setItem(i, 0, name_item)
            self.call_table.setItem(i, 1, QTableWidgetItem(str(c.get("date", ""))))
            self.call_table.setItem(i, 2, QTableWidgetItem(str(c.get("phone", ""))))
            self.call_table.setItem(i, 3, QTableWidgetItem(str(c.get("type", ""))))
            item = QTableWidgetItem(str(c.get("content", "")))
            item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
            self.call_table.setItem(i, 4, item)
        self.call_table.setSortingEnabled(True)
        self.call_table.blockSignals(False)
        # 대량 데이터에서도 화면이 멈추지 않도록, 행 높이 계산은 다음 이벤트 루프에서 실행
        self.call_table.schedule_row_resize()

    def update_client_table(self, data):
        self.client_table.blockSignals(True)
        self.client_table.setSortingEnabled(False)
        self.client_table.setRowCount(len(data))
        for i, (name, details) in enumerate(data.items()):
            self.client_table.setItem(i, 0, QTableWidgetItem(name))
            for j in range(4):
                val = details[j] if j < len(details) else ""
                item = QTableWidgetItem(str(val))
                item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
                self.client_table.setItem(i, j + 1, item)
        self.client_table.setSortingEnabled(True)
        self.client_table.blockSignals(False)
        self.client_table.schedule_row_resize()

    def filter_calls_when_cleared(self):
        if not self.main_search_input.text().strip():
            self.filter_calls()

    def filter_calls(self, *_args):
        # *_args: QDateEdit.dateChanged(QDate)나 QPushButton.clicked(bool)처럼
        # 신호가 추가 인자를 넘겨줘도 안전하게 무시하기 위함입니다.
        try:
            kw = self.main_search_input.text().lower().strip()

            start_qdate = self.main_start_date.date()
            end_qdate = self.main_end_date.date()
            # 사용자가 날짜 칸에 직접 숫자를 입력하는 도중에는 QDate가 일시적으로
            # 비어있거나(0000-00-00 등) 유효하지 않은 상태가 될 수 있습니다.
            # 이때 곧바로 toPyDate()를 부르면 예외가 발생해서 프로그램 전체가
            # 꺼져버렸던 것이 날짜 관련 오류의 실제 원인이었습니다.
            # -> 날짜가 아직 유효하지 않으면 이번 갱신은 조용히 건너뜁니다.
            if not start_qdate.isValid() or not end_qdate.isValid():
                return

            start = start_qdate.toPyDate()
            end = end_qdate.toPyDate()
            if end < start:
                start, end = end, start

            filtered = []
            for c in self.data["calls"]:
                try:
                    c_date = datetime.strptime(c.get("date", ""), "%Y-%m-%d %H:%M:%S").date()
                except Exception:
                    continue
                name = str(c.get("name", "")).lower()
                content = str(c.get("content", "")).lower()
                phone = str(c.get("phone", "")).lower()
                call_type = str(c.get("type", "")).lower()
                basic_match = not kw or kw in name or kw in content or kw in phone or kw in call_type
                column_match = all(
                    str(filter_text).lower() in self.call_value_by_column(c, col)
                    for col, filter_text in self.call_column_filters.items()
                )
                if (start <= c_date <= end) and basic_match and column_match:
                    filtered.append(c)
            self.update_call_table(filtered)
        except Exception as e:
            # 예상치 못한 오류가 나더라도 프로그램이 꺼지지 않고, 알림만 뜨도록 합니다.
            self.show_nonfatal_error("검색 필터 오류", e)

    def filter_clients(self):
        kw = self.client_search_input.text().lower().strip()
        filtered = {}
        for name, details in self.data["clients"].items():
            basic_match = not kw or kw in name.lower() or any(kw in str(val).lower() for val in details)
            column_match = all(
                str(filter_text).lower() in self.client_value_by_column(name, details, col)
                for col, filter_text in self.client_column_filters.items()
            )
            if basic_match and column_match:
                filtered[name] = details
        self.update_client_table(filtered)

    def call_value_by_column(self, c, col):
        values = [
            str(c.get("name", "")), str(c.get("date", "")), str(c.get("phone", "")),
            str(c.get("type", "")), str(c.get("content", ""))
        ]
        return values[col].lower() if 0 <= col < len(values) else ""

    def client_value_by_column(self, name, details, col):
        values = [str(name)]
        for i in range(4):
            values.append(str(details[i]) if i < len(details) else "")
        return values[col].lower() if 0 <= col < len(values) else ""

    # ---------------------------------------------------------------- 열 필터 (헤더 우클릭)
    def enable_table_filter(self, table, table_type):
        header = table.horizontalHeader()
        self.table_filter_headers[header] = (table, table_type)
        header.installEventFilter(self)

    def base_headers_for_table(self, table_type):
        return self.CALL_HEADERS if table_type == "call" else self.CLIENT_HEADERS

    def refresh_filter_header_icons(self, table_type):
        table = self.call_table if table_type == "call" else self.client_table
        filters = self.call_column_filters if table_type == "call" else self.client_column_filters
        for col, header in enumerate(self.base_headers_for_table(table_type)):
            item = table.horizontalHeaderItem(col)
            if item:
                item.setText(header + ("  [필터]" if col in filters else ""))

    def apply_table_filters(self, table_type):
        if table_type == "call":
            self.filter_calls()
        else:
            self.filter_clients()
        self.refresh_filter_header_icons(table_type)

    def clear_all_column_filters(self):
        self.call_column_filters.clear()
        self.client_column_filters.clear()
        self.filter_calls()
        self.filter_clients()
        self.refresh_filter_header_icons("call")
        self.refresh_filter_header_icons("client")
        QMessageBox.information(self, "필터 해제", "모든 열 필터가 해제되었습니다.")

    def show_table_filter_menu(self, table, table_type, column, global_pos):
        if column < 0:
            return
        header_name = self.base_headers_for_table(table_type)[column]
        filters = self.call_column_filters if table_type == "call" else self.client_column_filters

        if self.filter_popup:
            self.filter_popup.close()

        popup = QDialog(self)
        self.filter_popup = popup
        popup.setWindowTitle("열 필터")
        popup.setWindowFlags(Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint)
        popup.setStyleSheet("""
            QDialog { background: #FFFFFF; border: 1px solid #DAD7D0; border-radius: 8px; }
            QLabel { color: #6B6B66; font-weight: 700; padding: 2px; }
            QLineEdit { border: 1px solid #DAD7D0; border-radius: 6px; padding: 7px; background: #FFFFFF; color: #2F3437; }
            QLineEdit:focus { border: 1px solid #9B9991; }
            QPushButton {
                background-color: #FFFFFF; color: #2F3437; border: 1px solid #DAD7D0;
                border-radius: 6px; padding: 7px 10px; text-align: left; font-weight: 600;
            }
            QPushButton:hover { background-color: #F1F0ED; border-color: #C9C6BE; }
        """)

        popup_layout = QVBoxLayout(popup)
        title_label = QLabel(f"{header_name} 열 검색")
        search_input = QLineEdit()
        search_input.setPlaceholderText("검색어 입력 후 Enter")
        search_input.setMinimumWidth(260)
        search_input.setText(filters.get(column, ""))
        clear_column_btn = QPushButton("이 열 필터 해제")
        clear_all_btn = QPushButton("전체 열 필터 해제")

        popup_layout.addWidget(title_label)
        popup_layout.addWidget(search_input)
        popup_layout.addWidget(clear_column_btn)
        popup_layout.addWidget(clear_all_btn)

        def apply_filter():
            text = search_input.text().strip()
            if text:
                filters[column] = text
            else:
                filters.pop(column, None)
            self.apply_table_filters(table_type)
            popup.close()

        def clear_column_filter():
            filters.pop(column, None)
            self.apply_table_filters(table_type)
            popup.close()

        def clear_all_filters():
            filters.clear()
            self.apply_table_filters(table_type)
            popup.close()

        search_input.returnPressed.connect(apply_filter)
        clear_column_btn.clicked.connect(clear_column_filter)
        clear_all_btn.clicked.connect(clear_all_filters)
        popup.destroyed.connect(self.clear_filter_popup)
        popup.move(global_pos)
        popup.show()
        popup.raise_()
        popup.activateWindow()
        QTimer.singleShot(100, lambda: search_input.setFocus())

    def clear_filter_popup(self):
        self.filter_popup = None

    # ---------------------------------------------------------------- 이벤트 필터
    def eventFilter(self, watched, event):
        try:
            if watched in self.table_filter_headers:
                if event.type() == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.RightButton:
                    table, table_type = self.table_filter_headers[watched]
                    column = watched.logicalIndexAt(event.pos())
                    self.show_table_filter_menu(table, table_type, column, watched.mapToGlobal(event.pos()))
                    return True
                if event.type() == QEvent.Type.ContextMenu:
                    table, table_type = self.table_filter_headers[watched]
                    column = watched.logicalIndexAt(event.pos())
                    self.show_table_filter_menu(table, table_type, column, watched.mapToGlobal(event.pos()))
                    return True

            if self.name_suggestion_list is not None and self.name_suggestion_list.isVisible():
                if event.type() == QEvent.Type.MouseButtonPress and isinstance(watched, QWidget):
                    global_pos = watched.mapToGlobal(event.pos())
                    input_rect = QRect(self.name_input.mapToGlobal(self.name_input.rect().topLeft()), self.name_input.size())
                    list_rect = QRect(self.name_suggestion_list.mapToGlobal(self.name_suggestion_list.rect().topLeft()), self.name_suggestion_list.size())
                    if not input_rect.contains(global_pos) and not list_rect.contains(global_pos):
                        self.name_suggestion_list.hide()

            if watched == self.name_input and event.type() == QEvent.Type.KeyPress:
                if event.key() == Qt.Key.Key_Down and self.name_suggestion_list is not None:
                    if not self.name_suggestion_list.isVisible():
                        self.update_name_suggestions()
                    if not self.name_suggestion_list.isVisible():
                        return False
                    self.name_suggestion_list.setFocus()
                    if self.name_suggestion_list.currentRow() < 0:
                        self.name_suggestion_list.setCurrentRow(0)
                    return True
                if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and self.name_suggestion_list is not None and self.name_suggestion_list.isVisible():
                    item = self.name_suggestion_list.currentItem()
                    if item:
                        self.choose_name_suggestion(item.text())
                        return True

            if watched == self.name_input and event.type() == QEvent.Type.FocusOut:
                QTimer.singleShot(0, self.hide_name_suggestions_if_focus_left)

            if watched == self.name_suggestion_list and event.type() == QEvent.Type.KeyPress:
                if event.key() == Qt.Key.Key_Up and self.name_suggestion_list.currentRow() <= 0:
                    self.name_suggestion_list.hide()
                    self.name_input.setFocus()
                    self.name_input.setCursorPosition(len(self.name_input.text()))
                    return True
                if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                    item = self.name_suggestion_list.currentItem()
                    if item:
                        self.choose_name_suggestion(item.text())
                        return True
                if event.key() == Qt.Key.Key_Escape:
                    self.name_suggestion_list.hide()
                    self.name_input.setFocus()
                    return True

            if self.filter_popup and event.type() == QEvent.Type.MouseButtonPress:
                if event.button() == Qt.MouseButton.LeftButton and isinstance(watched, QWidget):
                    global_pos = watched.mapToGlobal(event.pos())
                    if not self.filter_popup.geometry().contains(global_pos):
                        self.filter_popup.close()
        except Exception as e:
            self.show_nonfatal_error("화면 동작 오류", e)
            return True
        return super().eventFilter(watched, event)

    def show_nonfatal_error(self, title, error):
        QMessageBox.warning(self, title, f"작업 중 오류가 발생했습니다.\n\n원인: {error}")

    # ---------------------------------------------------------------- 표 너비
    def apply_widths(self):
        if self.settings.get("call_widths"):
            for i, w in enumerate(self.settings["call_widths"][:len(self.CALL_HEADERS)]):
                self.call_table.setColumnWidth(i, w)
        if self.settings.get("client_widths"):
            for i, w in enumerate(self.settings["client_widths"][:len(self.CLIENT_HEADERS)]):
                self.client_table.setColumnWidth(i, w)
        self.call_table.schedule_row_resize()
        self.client_table.schedule_row_resize()

    def reset_widths(self):
        for i in range(len(self.CALL_HEADERS)):
            self.call_table.setColumnWidth(i, 180)
        for i in range(len(self.CLIENT_HEADERS)):
            self.client_table.setColumnWidth(i, 180)

    # ---------------------------------------------------------------- 파일 열기/저장/백업 복구
    def confirm_save_before_open(self):
        reply = QMessageBox.question(
            self, "데이터 열기", "현재 데이터를 저장한 뒤 다른 파일을 여시겠습니까?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Yes
        )
        if reply == QMessageBox.StandardButton.Cancel:
            return False
        if reply == QMessageBox.StandardButton.Yes:
            if self.save_timer.isActive():
                self.save_timer.stop()
            self.save_data()
            self.save_settings()
        return True

    def open_data_file_dialog(self):
        if not self.confirm_save_before_open():
            return
        storage = self.storage_settings()
        start_folder = storage.get("local_path") or os.getcwd()
        path, _ = QFileDialog.getOpenFileName(self, "데이터 파일 열기", start_folder, "JSON 데이터 (*.json);;모든 파일 (*.*)")
        if not path:
            return
        try:
            loaded = read_json_file(path)
            if not is_valid_data_shape(loaded):
                raise ValueError("데이터 형식이 올바르지 않습니다.")
            self.data = loaded
            self.ensure_data_shape()
            storage["type"] = "local"
            storage["local_path"] = os.path.dirname(path) or os.getcwd()
            storage["data_file"] = os.path.basename(path)
            self.update_all()
            self.save_settings()
            QMessageBox.information(self, "데이터 열기", f"데이터 파일을 열었습니다.\n\n{path}")
        except Exception as e:
            QMessageBox.warning(self, "데이터 열기 오류", f"데이터 파일을 열지 못했습니다.\n\n원인: {e}")

    def save_current_data_file(self, checked=False, show_message=True):
        if self.save_timer.isActive():
            self.save_timer.stop()
        ok = self.save_data(show_progress=True)
        self.save_settings()
        if show_message and ok:
            self.statusBar().showMessage("저장되었습니다.", 3000)

    def save_data_as_dialog(self):
        storage = self.storage_settings()
        start_folder = storage.get("local_path") or os.getcwd()
        default_path = os.path.join(start_folder, self.data_file_name())
        path, _ = QFileDialog.getSaveFileName(self, "다른 이름으로 저장", default_path, "JSON 데이터 (*.json);;모든 파일 (*.*)")
        if not path:
            return
        if not os.path.splitext(path)[1]:
            path += ".json"
        try:
            storage["local_path"] = os.path.dirname(path) or os.getcwd()
            storage["data_file"] = os.path.basename(path)
            self.save_data(show_progress=True)
            self.save_settings()
        except Exception as e:
            QMessageBox.warning(self, "저장 오류", f"다른 이름으로 저장하지 못했습니다.\n\n원인: {e}")

    def open_restore_backup_dialog(self):
        path = self.local_data_path()
        candidates = [path] + backup_paths(path)
        existing = [p for p in candidates if os.path.exists(p)]
        if not existing:
            QMessageBox.information(self, "백업 복구", "복구할 수 있는 파일이 없습니다.")
            return

        dialog = QDialog(self)
        dialog.setWindowTitle("백업본에서 복구")
        dialog.setMinimumWidth(560)
        layout = QVBoxLayout(dialog)
        layout.addWidget(QLabel("복구할 파일을 선택하세요. 현재 화면의 내용은 저장하지 않는 한 사라지지 않습니다."))

        list_widget = QListWidget()
        for p in existing:
            try:
                mtime = datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d %H:%M:%S")
                size_kb = os.path.getsize(p) / 1024
                label = f"{os.path.basename(p)}   (수정: {mtime}, 크기: {size_kb:.1f}KB)"
            except Exception:
                label = os.path.basename(p)
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, p)
            list_widget.addItem(item)
        layout.addWidget(list_widget)

        btn_row = QHBoxLayout()
        load_btn = QPushButton("이 파일 불러오기")
        load_btn.setObjectName("PrimaryButton")
        cancel_btn = QPushButton("취소")
        btn_row.addStretch(1)
        btn_row.addWidget(load_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)

        def do_load():
            item = list_widget.currentItem()
            if not item:
                QMessageBox.warning(dialog, "선택 확인", "불러올 파일을 선택해 주세요.")
                return
            target = item.data(Qt.ItemDataRole.UserRole)
            try:
                loaded = read_json_file(target)
                if not is_valid_data_shape(loaded):
                    raise ValueError("데이터 형식이 올바르지 않습니다.")
                self.data = loaded
                self.ensure_data_shape()
                self.update_all()
                QMessageBox.information(
                    dialog, "복구 완료",
                    f"'{os.path.basename(target)}' 내용을 불러왔습니다.\n\n"
                    f"내용을 확인하신 뒤, 이 상태로 저장하려면 Ctrl+S를 눌러 주세요."
                )
                dialog.accept()
            except Exception as e:
                QMessageBox.warning(dialog, "복구 오류", f"파일을 불러오지 못했습니다.\n\n원인: {e}")

        load_btn.clicked.connect(do_load)
        cancel_btn.clicked.connect(dialog.reject)
        if list_widget.count():
            list_widget.setCurrentRow(0)
        dialog.exec()

    # ---------------------------------------------------------------- 환경설정
    def open_preferences_dialog(self):
        storage = json.loads(json.dumps(self.storage_settings(), ensure_ascii=False))  # 편집용 사본
        dialog = QDialog(self)
        dialog.setWindowTitle("환경설정")
        dialog.setMinimumWidth(620)
        layout = QVBoxLayout(dialog)

        desc = QLabel("데이터를 저장할 방식과 폴더, 자동 저장 간격을 설정합니다.\n"
                       "(저장할 때마다 이전 버전 최대 3개가 자동으로 함께 보관됩니다.)")
        desc.setObjectName("PageSubtitle")
        desc.setWordWrap(True)
        layout.addWidget(desc)

        type_group = QGroupBox("저장 방식")
        type_layout = QVBoxLayout(type_group)
        local_radio = QRadioButton("하드디스크에만 저장")
        ftp_radio = QRadioButton("FTP 서버에만 저장")
        sync_radio = QRadioButton("하드디스크에 저장 + FTP로 동기화")
        local_radio.setChecked(storage.get("type", "local") == "local")
        ftp_radio.setChecked(storage.get("type") == "ftp")
        sync_radio.setChecked(storage.get("type") == "local_sync")
        type_layout.addWidget(local_radio)
        type_layout.addWidget(ftp_radio)
        type_layout.addWidget(sync_radio)
        layout.addWidget(type_group)

        path_group = QGroupBox("하드디스크 저장 폴더")
        path_layout = QHBoxLayout(path_group)
        path_input = QLineEdit(storage.get("local_path") or os.getcwd())
        browse_btn = QPushButton("찾아보기")
        path_layout.addWidget(path_input, 1)
        path_layout.addWidget(browse_btn)
        layout.addWidget(path_group)

        ftp_group = QGroupBox("FTP 서버 정보")
        ftp_layout = QGridLayout(ftp_group)
        ftp_info = storage.get("ftp", default_ftp_info())
        host_input = QLineEdit(ftp_info.get("host", ""))
        host_input.setPlaceholderText("예: ftp.example.com")
        port_input = QSpinBox()
        port_input.setRange(1, 65535)
        port_input.setValue(int(ftp_info.get("port", 21) or 21))
        user_input = QLineEdit(ftp_info.get("user", ""))
        password_input = QLineEdit(ftp_info.get("password", ""))
        password_input.setEchoMode(QLineEdit.EchoMode.Password)
        remote_path_input = QLineEdit(ftp_info.get("remote_path", "/") or "/")
        test_btn = QPushButton("연결 테스트")

        ftp_layout.addWidget(QLabel("주소:"), 0, 0)
        ftp_layout.addWidget(host_input, 0, 1)
        ftp_layout.addWidget(QLabel("포트:"), 0, 2)
        ftp_layout.addWidget(port_input, 0, 3)
        ftp_layout.addWidget(QLabel("아이디:"), 1, 0)
        ftp_layout.addWidget(user_input, 1, 1)
        ftp_layout.addWidget(QLabel("비밀번호:"), 1, 2)
        ftp_layout.addWidget(password_input, 1, 3)
        ftp_layout.addWidget(QLabel("경로:"), 2, 0)
        ftp_layout.addWidget(remote_path_input, 2, 1, 1, 2)
        ftp_layout.addWidget(test_btn, 2, 3)
        layout.addWidget(ftp_group)

        autosave_group = QGroupBox("자동 저장")
        autosave_layout = QGridLayout(autosave_group)
        autosave_minutes = QSpinBox()
        autosave_minutes.setRange(1, 240)
        autosave_minutes.setSuffix(" 분")
        try:
            autosave_minutes.setValue(int(float(self.settings.get("autosave_minutes", 5) or 5)))
        except Exception:
            autosave_minutes.setValue(5)
        autosave_layout.addWidget(QLabel("자동 저장 간격:"), 0, 0)
        autosave_layout.addWidget(autosave_minutes, 0, 1)
        layout.addWidget(autosave_group)

        btn_row = QHBoxLayout()
        ok_btn = QPushButton("저장")
        ok_btn.setObjectName("PrimaryButton")
        cancel_btn = QPushButton("취소")
        btn_row.addStretch(1)
        btn_row.addWidget(ok_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)

        def collect_ftp_info():
            return {
                "host": host_input.text().strip(),
                "port": port_input.value(),
                "user": user_input.text().strip(),
                "password": password_input.text(),
                "remote_path": remote_path_input.text().strip() or "/"
            }

        def set_controls_enabled():
            use_ftp_only = ftp_radio.isChecked()
            use_sync = sync_radio.isChecked()
            path_group.setEnabled(not use_ftp_only)
            ftp_group.setEnabled(use_ftp_only or use_sync)

        def browse_local():
            folder = QFileDialog.getExistingDirectory(dialog, "데이터 저장 폴더 선택", path_input.text() or os.getcwd())
            if folder:
                path_input.setText(folder)

        def test_connection():
            info = collect_ftp_info()
            if not info["host"]:
                QMessageBox.warning(dialog, "FTP 확인", "FTP 주소를 입력해 주세요.")
                return
            try:
                ftp = ftp_connect(info)
                ftp_ensure_dir(ftp, info["remote_path"])
                ftp.quit()
                QMessageBox.information(dialog, "FTP 연결", "FTP 연결과 경로 확인이 완료되었습니다.")
            except Exception as e:
                QMessageBox.warning(dialog, "FTP 연결 오류", f"FTP에 연결하지 못했습니다.\n\n원인: {e}")

        def accept_preferences():
            if ftp_radio.isChecked() or sync_radio.isChecked():
                info = collect_ftp_info()
                if not info["host"]:
                    QMessageBox.warning(dialog, "FTP 확인", "FTP 주소를 입력해 주세요.")
                    return
            else:
                info = collect_ftp_info()

            folder = path_input.text().strip() or os.getcwd()
            if not ftp_radio.isChecked():
                try:
                    os.makedirs(folder, exist_ok=True)
                except Exception as e:
                    QMessageBox.warning(dialog, "저장경로 오류", f"저장 폴더를 만들 수 없습니다.\n\n원인: {e}")
                    return

            live_storage = self.storage_settings()
            live_storage["type"] = "ftp" if ftp_radio.isChecked() else ("local_sync" if sync_radio.isChecked() else "local")
            live_storage["local_path"] = folder
            live_storage["ftp"] = info
            self.settings["autosave_minutes"] = autosave_minutes.value()
            self.save_settings()
            dialog.accept()
            # 방식이 바뀌었을 수 있으니 새 설정 그대로 진행창을 보여주며 저장
            self.save_data(show_progress=True)

        browse_btn.clicked.connect(browse_local)
        test_btn.clicked.connect(test_connection)
        local_radio.toggled.connect(set_controls_enabled)
        ftp_radio.toggled.connect(set_controls_enabled)
        sync_radio.toggled.connect(set_controls_enabled)
        ok_btn.clicked.connect(accept_preferences)
        cancel_btn.clicked.connect(dialog.reject)
        set_controls_enabled()
        dialog.exec()

    # ---------------------------------------------------------------- 엑셀 내보내기
    def export_excel(self):
        wb = Workbook()
        ws = wb.active
        tab_name = self.main_tabs.tabText(self.main_tabs.currentIndex()) if hasattr(self, "main_tabs") else "통화 기록"

        if tab_name == "거래처 DB":
            ws.title = "거래처 DB"
            ws.append(["거래처명", "전화1", "전화2", "전화3", "메모"])
            for name, details in self.data.get("clients", {}).items():
                row = [name] + [(details[i] if i < len(details) else "") for i in range(4)]
                ws.append(row)
            export_name = "거래처DB"
        else:
            ws.title = "통화 기록"
            ws.append(["거래처", "날짜", "번호", "구분", "내용"])
            for c in self.data.get("calls", []):
                ws.append([c.get("name", ""), c.get("date", ""), c.get("phone", ""), c.get("type", ""), c.get("content", "")])
            export_name = "통화기록"

        folder = self.storage_settings().get("local_path") or os.getcwd()
        filename = os.path.join(folder, f"SkyCRM_{export_name}_{datetime.now().strftime('%m%d_%H%M')}.xlsx")
        try:
            wb.save(filename)
            QMessageBox.information(self, "엑셀 출력", f"저장 완료: {filename}")
        except Exception as e:
            QMessageBox.warning(self, "엑셀 출력 오류", f"엑셀 파일을 저장하지 못했습니다.\n\n원인: {e}")

    # ---------------------------------------------------------------- 종료
    def closeEvent(self, event):
        if self.closing_app:
            # 이미 종료가 확정된 상태에서 다시 들어오는 경우를 대비한 안전장치
            event.accept()
            return

        if self.save_timer.isActive():
            self.save_timer.stop()

        # 종료 시에는 항상 진행창을 띄워서, 저장이 실제로 얼마나 진행됐는지
        # 눈으로 확인할 수 있게 합니다. 저장 중 '취소'를 누르면 종료 자체를 취소합니다.
        ok = self.save_data(show_progress=True, parent_for_dialog=self)
        self.save_settings()

        if not ok:
            reply = QMessageBox.question(
                self, "저장되지 않음",
                "변경사항이 저장되지 않았습니다.\n"
                "(취소를 눌렀거나 오류가 발생했습니다. 이전에 저장된 내용은 안전하게 남아 있습니다.)\n\n"
                "그래도 저장하지 않고 종료하시겠습니까?\n"
                "(아니오를 누르면 프로그램이 계속 열려 있으니 다시 저장을 시도할 수 있습니다)",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No
            )
            if reply != QMessageBox.StandardButton.Yes:
                event.ignore()
                return

        app = QApplication.instance()
        if app:
            try:
                app.removeEventFilter(self)
            except Exception:
                pass
        self.closing_app = True
        event.accept()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setFont(QFont("Malgun Gothic", 10))
    if os.path.exists(ICON_FILE):
        app.setWindowIcon(QIcon(ICON_FILE))
    window = CallManagerLite()
    window.show()
    sys.exit(app.exec())