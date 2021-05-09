import { FC, useState } from "react";
import LoadingOverlay from "./LoadingOverlay";
import { DiscussionParentType } from "back-end/types/discussion";
import { useAuth } from "../services/auth";
import MarkdownInput from "./Markdown/MarkdownInput";

const CommentForm: FC<{
  cta: string;
  type: DiscussionParentType;
  id: string;
  index: number;
  initialValue?: string;
  autofocus?: boolean;
  onSave: () => void;
  onCancel?: () => void;
}> = ({ cta, type, id, index, initialValue, autofocus, onSave, onCancel }) => {
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(initialValue || "");
  const { apiCall } = useAuth();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();

        if (loading || value.length < 1) return;
        setLoading(true);
        setFormError(null);
        try {
          if (index >= 0) {
            await apiCall(`/discussion/${type}/${id}/${index}`, {
              method: "PUT",
              body: JSON.stringify({ comment: value }),
            });
          } else {
            await apiCall(`/discussion/${type}/${id}`, {
              method: "POST",
              body: JSON.stringify({ comment: value }),
            });
          }
          setValue("");
          onSave();
        } catch (e) {
          setFormError(e.message || "Error saving comment");
        }

        setLoading(false);
      }}
    >
      {loading && <LoadingOverlay />}
      <MarkdownInput
        value={value}
        setValue={setValue}
        autofocus={autofocus}
        cta={cta}
        onCancel={onCancel}
        error={formError}
      />
    </form>
  );
};
export default CommentForm;