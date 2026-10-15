        tree = self.task_tree if e["kind"] == "task" else self.note_tree
        item = tree.currentItem()
        if item:
            tree.blockSignals(True)
            item.setText(1, e["text"].splitlines()[0][:160] if e["text"].strip() else "(내용 없음)")
            item.setToolTip(1, e["text"])
            for col, key in [(2, "name"), (3, "date"), (4, "phone")]:
                item.setText(col, e[key])
            tree.blockSignals(False)
        self.request_save_data(700)

    def add_memo(self, kind, parent=""):
        e = self.make_entry(kind, parent=parent)
        self.entries().append(e)
        self.memo_selected_id = e["id"]
        if parent:
            self.entry(parent)["expanded"] = True
        self.refresh_memos()
        self.memo_text.setFocus()
        self.request_save_data(400)

    def add_child_task(self):
        e = self.entry(self.memo_selected_id)
        if e and e["kind"] == "task":
            self.add_memo("task", e["id"])
        else:
            self.statusBar().showMessage("상위 할 일을 먼저 선택해 주세요.", 4000)

    def move_task(self, uid, parent):
        e = self.entry(uid)
        target = self.entry(parent)
        if not e or e["kind"] != "task" or (parent and (not target or target["kind"] != "task")):
            return
        cursor = parent
        while cursor:
            if cursor == uid:
                return
            ancestor = self.entry(cursor)
            cursor = ancestor["parent"] if ancestor else ""
        e["parent"] = parent
        if target:
            target["expanded"] = True
        self.memo_selected_id = uid
        self.refresh_memos()
        self.request_save_data(400)

    def detach_task(self):
        self.move_task(self.memo_selected_id, "")

    def change_kind(self, e, kind):
        if kind == "note":
            for child in self.entries():
                if child["parent"] == e["id"]:
                    child["parent"] = e["parent"]
            e["parent"] = ""
        e["kind"] = kind

    def convert_memo(self):
        e = self.entry(self.memo_selected_id)
        if e:
            self.change_kind(e, "note" if e["kind"] == "task" else "task")
            self.refresh_memos()
            self.refresh_call_table_only()
            self.request_save_data(400)

    def delete_memo(self):
        e = self.entry(self.memo_selected_id)
        if not e:
            return
        answer = QMessageBox.question(self, "삭제", "선택한 항목을 삭제할까요? 하위 할 일은 남겨 상위로 이동합니다.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No)
        if answer != QMessageBox.StandardButton.Yes:
            return
        for child in self.entries():
            if child["parent"] == e["id"]:
                child["parent"] = e["parent"]
        self.entries().remove(e)
        self.memo_selected_id = ""
        self.refresh_memos()
        self.refresh_call_table_only()
        self.request_save_data(400)

    def task_changed(self, item, col):
        if self.memo_loading or col != 0:
            return
        e = self.entry(item.data(0, Qt.ItemDataRole.UserRole))
        if e:
            e["done"] = item.checkState(0) == Qt.CheckState.Checked
            font = item.font(1)
            font.setStrikeOut(e["done"])
            self.task_tree.blockSignals(True)
            item.setFont(1, font)
            self.task_tree.blockSignals(False)
            self.request_save_data(400)

    def remember_expansion(self, item, expanded):
        if self.memo_loading:
            return
        e = self.entry(item.data(0, Qt.ItemDataRole.UserRole))
        if e:
            e["expanded"] = expanded
            self.request_save_data(700)

    def export_excel(self):
        if self.main_tabs.tabText(self.main_tabs.currentIndex()) != "메모":
            return super().export_excel()
        wb = Workbook()
        ws = wb.active
        ws.title = "메모 및 할 일"
        ws.append(["ID", "상위 ID", "종류", "완료", "거래처", "통화 날짜", "전화번호", "내용"])
        for e in self.entries():
            ws.append([e["id"], e["parent"], "할 일" if e["kind"] == "task" else "일반 메모",
                       "완료" if e["done"] and e["kind"] == "task" else "", e["name"], e["date"], e["phone"], e["text"]])
        filename, _ = QFileDialog.getSaveFileName(self, "메모 엑셀 저장", "메모_할일.xlsx", "Excel (*.xlsx)")
        if filename:
            try:
                wb.save(filename)
                QMessageBox.information(self, "엑셀 출력", "메모와 할 일을 저장했습니다.")
            except Exception as error:
                self.show_nonfatal_error("엑셀 출력 오류", error)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setFont(QFont("Malgun Gothic", 10))
    if os.path.exists(ICON_FILE):
        app.setWindowIcon(QIcon(ICON_FILE))
    window = CallManagerWithMemos()
